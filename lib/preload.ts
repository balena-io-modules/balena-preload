import * as _ from 'lodash';
import * as EventEmitter from 'events';
import * as dockerProgress from 'docker-progress';
import * as Docker from 'dockerode';
import * as path from 'path';
import * as streamModule from 'stream';
import * as Bluebird from 'bluebird';
import * as tarfs from 'tar-fs';
import { promises as fs, constants } from 'fs';
import * as getPort from 'get-port';
import * as os from 'os';
import * as compareVersions from 'compare-versions';
import * as request from 'request-promise';
import type {
	Application,
	BalenaSDK,
	DeviceType,
	PineDeferred,
	PineExpand,
	PineFilter,
	Release,
} from 'balena-sdk';

const { R_OK, W_OK } = constants;

const DOCKER_TMPDIR = '/docker_tmpdir';
const DOCKER_IMAGE_TAG = 'balena/balena-preload';
const DISK_IMAGE_PATH_IN_DOCKER = '/img/balena.img';
const SPLASH_IMAGE_PATH_IN_DOCKER = '/img/balena-logo.png';
const DOCKER_STEP_RE = /Step (\d+)\/(\d+)/;
const CONCURRENT_REQUESTS_TO_REGISTRY = 10;

const GRAPHDRIVER_ERROR =
	'Error starting daemon: error initializing graphdriver: driver not supported';
const OVERLAY_MODULE_MESSAGE =
	'You need to load the "overlay" module to be able to preload this image: run "sudo modprobe overlay".';
const DOCKERD_USES_OVERLAY = '--storage-driver=overlay2';

const SUPERVISOR_USER_AGENT =
	'Supervisor/v6.6.0 (Linux; Resin OS 2.12.3; prod)';

const MISSING_APP_INFO_ERROR_MSG =
	'Could not fetch the target state because of missing application info';

class BufferBackedWritableStream extends streamModule.Writable {
	chunks: Buffer[] = [];

	_write(chunk, _enc, next) {
		this.chunks.push(chunk);
		next();
	}

	getData() {
		return Buffer.concat(this.chunks);
	}
}

function setBindMount(
	hostConfig: Docker.HostConfig,
	mounts: Array<[string, string]>,
	dockerApiVersion: string,
) {
	if (compareVersions(dockerApiVersion, '1.25') >= 0) {
		hostConfig.Mounts = mounts.map(([source, target]) => ({
			Source: path.resolve(source),
			Target: target,
			Type: 'bind',
			Consistency: 'delegated',
		}));
	} else {
		hostConfig.Binds = mounts.map(
			([source, target]) => `${path.resolve(source)}:${target}`,
		);
	}
}

type Layer = {
	digest: any;
	size: number;
};

type Manifest = {
	manifest: {
		layers: Layer[];
	};
	imageLocation: string;
};

type Image = {
	is_stored_at__image_location: string;
	image_size: number;
};

interface ImageInfo {
	preloaded_builds: string[];
	supervisor_version: string;
	free_space: number;
	config: {
		deviceType: string;
	};
	balena_os_version: string;
}

/** @const {String} Container name */
export const CONTAINER_NAME = 'balena-image-preloader';

export const applicationExpandOptions = {
	owns__release: {
		$select: ['id', 'commit', 'end_timestamp', 'composition'],
		$expand: {
			contains__image: {
				$select: ['image'],
				$expand: {
					image: {
						$select: ['image_size', 'is_stored_at__image_location'],
					},
				},
			},
		},
		$filter: {
			status: 'success',
		},
		$orderby: [{ end_timestamp: 'desc' }, { id: 'desc' }],
	},
} satisfies PineExpand<Application>;

const createContainer = async (
	docker: Docker,
	image: string,
	splashImage: string | undefined,
	dockerPort: number,
	proxy: string,
) => {
	const mounts: Array<[string, string]> = [];
	const version = await docker.version();
	if (os.platform() === 'linux') {
		// In some situations, devices created by `losetup -f` in the container only appear on the host and not in the container.
		// See https://github.com/balena-io/balena-cli/issues/1008
		mounts.push(['/dev', '/dev']);
	}
	if (splashImage) {
		mounts.push([splashImage, SPLASH_IMAGE_PATH_IN_DOCKER]);
	}

	const env = [
		`HTTP_PROXY=${proxy || ''}`,
		`HTTPS_PROXY=${proxy || ''}`,
		`DOCKER_PORT=${dockerPort || ''}`,
		`DOCKER_TMPDIR=${DOCKER_TMPDIR}`,
	];

	mounts.push([image, DISK_IMAGE_PATH_IN_DOCKER]);

	const containerOptions: Docker.ContainerCreateOptions = {
		Image: DOCKER_IMAGE_TAG,
		name: CONTAINER_NAME,
		AttachStdout: true,
		AttachStderr: true,
		OpenStdin: true,
		Env: env,
		Volumes: {
			[DOCKER_TMPDIR]: {},
		},
		HostConfig: {
			Privileged: true,
		},
	};
	// Before api 1.25 bind mounts were going to into HostConfig.Binds
	if (containerOptions.HostConfig !== undefined) {
		setBindMount(containerOptions.HostConfig, mounts, version.ApiVersion);
		if (os.platform() === 'linux') {
			containerOptions.HostConfig.NetworkMode = 'host';
		} else {
			containerOptions.HostConfig.NetworkMode = 'bridge';
			containerOptions.ExposedPorts = {};
			containerOptions.ExposedPorts[`${dockerPort}/tcp`] = {};
			containerOptions.HostConfig.PortBindings = {};
			containerOptions.HostConfig.PortBindings[`${dockerPort}/tcp`] = [
				{
					HostPort: `${dockerPort}`,
					HostIp: '',
				},
			];
		}
	}
	return await docker.createContainer(containerOptions);
};

const isReadWriteAccessibleFile = async (image) => {
	try {
		const [, stats] = await Promise.all([
			// tslint:disable-next-line:no-bitwise
			fs.access(image, R_OK | W_OK),
			fs.stat(image),
		]);
		return stats.isFile();
	} catch {
		return false;
	}
};

export class Preloader extends EventEmitter {
	application;
	stdin;
	stdout = new streamModule.PassThrough();
	stderr = new streamModule.PassThrough();
	bufferedStderr = new BufferBackedWritableStream();
	dockerPort;
	container;
	state; // device state from the api
	freeSpace: number | undefined; // space available on the image data partition (in bytes)
	preloadedBuilds: string[] | undefined; // list of preloaded Docker images in the disk image
	supervisorVersion: string | undefined; // disk image supervisor version
	balenaOSVersion: string | undefined; // OS version from the image's "/etc/issue" file
	config: ImageInfo['config'] | undefined; // config.json data from the disk image
	deviceTypes: DeviceType[] | undefined;
	balena: BalenaSDK;

	constructor(
		balena: BalenaSDK | undefined,
		public docker: Docker,
		public appId: number | string | undefined,
		public commit: string | undefined,
		public image: string,
		public splashImage: string | undefined,
		public proxy: any,
		public dontCheckArch: boolean,
		public pinDevice = false,
		public certificates: string[] = [],
		public additionalSpace: number | null = null,
	) {
		super();
		this.balena =
			balena ??
			(
				require('balena-sdk') as typeof import('balena-sdk')
			).fromSharedOptions();
		this.stderr.pipe(this.bufferedStderr); // TODO: split stderr and build output ?
	}

	/**
	 * Build the preloader docker image
	 * @returns Promise
	 */
	async _build() {
		const files = ['Dockerfile', 'requirements.txt', 'src/preload.py'];
		const name = 'Building Docker preloader image.';
		this._progress(name, 0);

		const tarStream = tarfs.pack(path.resolve(__dirname, '..'), {
			entries: files,
		});
		const build = await this.docker.buildImage(tarStream, {
			t: DOCKER_IMAGE_TAG,
		});
		await new Bluebird((resolve, reject) => {
			this.docker.modem.followProgress(
				build,
				(error, output) => {
					// onFinished
					if (!error && output && output.length) {
						error = output.pop().error;
					}
					if (error) {
						reject(error);
					} else {
						this._progress(name, 100);
						resolve();
					}
				},
				(event) => {
					// onProgress
					if (event.stream) {
						const matches = event.stream.match(DOCKER_STEP_RE);
						if (matches) {
							this._progress(
								name,
								(parseInt(matches[1], 10) / (parseInt(matches[2], 10) + 1)) *
									100,
							);
						}
						this.stderr.write(event.stream);
					}
				},
			);
		});
	}

	async _fetchDeviceTypes() {
		this.deviceTypes = await this.balena.models.deviceType.getAll({
			$select: 'slug',
			$expand: {
				is_of__cpu_architecture: {
					$select: 'slug',
				},
			},
		});
	}

	async _runWithSpinner(name, fn) {
		this._startSpinner(name);
		try {
			return await fn();
		} finally {
			this._stopSpinner(name);
		}
	}

	_prepareErrorHandler() {
		// Emit an error event if the python script exits with an error
		this.container
			?.wait()
			.then((data) => {
				if (data.StatusCode !== 0) {
					const output = this.bufferedStderr.getData().toString('utf8').trim();
					let error;
					if (
						output.indexOf(GRAPHDRIVER_ERROR) !== -1 &&
						output.indexOf(DOCKERD_USES_OVERLAY) !== -1
					) {
						error = new this.balena.errors.BalenaError(OVERLAY_MODULE_MESSAGE);
					} else {
						error = new Error(output);
						error.code = data.StatusCode;
					}
					this.emit('error', error);
				}
			})
			.catch((error) => this.emit('error', error));
	}

	/**
	 * Send a command to `preload.py` (running in a Docker container) through
	 * its stdin, and read a response from its stdout. The stdout response
	 * must be a JSON object containing a `statusCode` field (integer) and
	 * optionally `result` and `error` fields. If `statusCode` is the number
	 * zero, the command execution is considered successful, otherwise it is
	 * assumed to have failed and the returned promise is rejected with an
	 * error message including the message provided in the `error` field.
	 */
	_runCommand(command: string, parameters: { [name: string]: any }) {
		return new Bluebird((resolve, reject) => {
			const cmd = JSON.stringify({ command, parameters }) + '\n';
			this.stdout.once('error', reject);
			this.stdout.once('data', (data) => {
				let strData = data;
				try {
					strData = data.toString();
				} catch (_e) {
					// ignore
				}
				let response: any = {};
				try {
					response = JSON.parse(strData);
				} catch (error) {
					response.statusCode = 1;
					response.error = error;
				}
				if (response.statusCode === 0) {
					resolve(response.result);
				} else {
					const msg = [
						`An error has occurred executing internal preload command '${command}':`,
						cmd,
					];
					if (response.error) {
						msg.push(
							`Status code: ${response.statusCode}`,
							`Error: ${response.error}`,
						);
					} else {
						msg.push(`Response: ${strData}`);
					}
					msg.push('');
					reject(new Error(msg.join('\n')));
				}
			});
			this.stdin.write(cmd);
		});
	}

	_startSpinner(name) {
		this.emit('spinner', { name, action: 'start' });
	}

	_stopSpinner(name) {
		this.emit('spinner', { name, action: 'stop' });
	}

	_progress(name, percentage) {
		this.emit('progress', { name, percentage });
	}

	// Return the version of the target state endpoint used by the supervisor
	_getStateVersion() {
		if (this._supervisorLT7()) {
			return 1;
		} else if (this._supervisorLT13()) {
			return 2;
		} else {
			return 3;
		}
	}

	async _getStateWithRegistration(stateVersion: number) {
		if (!this.appId) {
			throw new Error(MISSING_APP_INFO_ERROR_MSG);
		}

		const uuid = this.balena.models.device.generateUniqueKey();

		const deviceInfo = await this.balena.models.device.register(
			this.appId,
			uuid,
		);
		await this.balena.pine.patch({
			resource: 'device',
			id: deviceInfo.id,
			body: {
				should_be_running__release: this._getRelease().id,
			},
		});

		const { body: state } = await this.balena.request.send({
			headers: { 'User-Agent': SUPERVISOR_USER_AGENT },
			// @ts-expect-error
			baseUrl: this.balena.pine.API_URL,
			url: `device/v${stateVersion}/${uuid}/state`,
		});
		this.state = state;
		await this.balena.models.device.remove(uuid);
	}

	async _getStateFromTargetEndpoint(stateVersion: number) {
		if (!this.appId) {
			throw new Error(MISSING_APP_INFO_ERROR_MSG);
		}

		const [{ uuid: appUuid }, state] = await Promise.all([
			this.balena.models.application.get(this.appId, {
				$select: 'uuid',
			}),
			this.balena.models.device.getSupervisorTargetStateForApp(this.appId),
		]);

		if (stateVersion === 3) {
			// State is keyed by application uuid in target state v3.
			// use .local to avoid having to reference by uuid elsewhere on this
			// module
			state.local = state[appUuid];
			delete state[appUuid];
		}

		this.state = state;
	}

	async _getState() {
		const stateVersion = this._getStateVersion();

		if (stateVersion < 3) {
			await this._getStateWithRegistration(stateVersion);
		} else {
			await this._getStateFromTargetEndpoint(stateVersion);
		}
	}

	async _getImageInfo() {
		// returns Promise<object> (device_type, preloaded_builds, free_space and config)
		await this._runWithSpinner('Reading image information', async () => {
			const info = (await this._runCommand('get_image_info', {})) as ImageInfo;
			this.freeSpace = info.free_space;
			this.preloadedBuilds = info.preloaded_builds;
			this.supervisorVersion = info.supervisor_version;
			this.balenaOSVersion = info.balena_os_version;
			this.config = info.config;
		});
	}

	_getCommit() {
		return this.commit || this.application.should_be_running__release[0].commit;
	}

	_getRelease() {
		const commit = this._getCommit();
		const releases = this.application.owns__release;
		if (commit === null && releases.length) {
			return releases[0];
		}
		const release = _.find(releases, (r) => {
			return r.commit.startsWith(commit);
		});
		if (!release) {
			throw new this.balena.errors.BalenaReleaseNotFound(commit);
		}
		return release;
	}

	_getServicesFromApps(apps) {
		const stateVersion = this._getStateVersion();
		// Use the version of the target state endpoint to know
		// how to read the apps object
		switch (stateVersion) {
			case 1:
				// Pre-multicontainer: there is only one image: use the only image from the state endpoint.
				const [appV1] = _.values(apps);
				return [{ image: appV1.image }];
			case 2:
				// Multicontainer: we need to match is_stored_at__image_location with service.image from the state v2 endpoint.
				const [appV2] = _.values(apps);
				return appV2.services;
			case 3:
				// v3 target state has a releases property which contains the services
				const [appV3] = _.values(apps).filter((a) => a.id === this.appId);
				const [release] = _.values(appV3?.releases ?? {});
				return release?.services ?? {};
		}
	}

	_getImages(): Image[] {
		// This method lists the images that need to be preloaded.
		// The is_stored_at__image_location attribute must match the image attribute of the app or app service in the state endpoint.
		// List images from the release.
		const images = this._getRelease().contains__image.map((ci) => {
			return _.merge({}, ci.image[0], {
				is_stored_at__image_location:
					ci.image[0].is_stored_at__image_location.toLowerCase(),
			});
		});

		// Multicontainer: we need to match is_stored_at__image_location with service.image from the state v2 endpoint.
		const servicesImages = _.map(
			this._getServicesFromApps(this.state.local.apps),
			(service) => {
				return service.image.toLowerCase();
			},
		);
		_.each(images, (image) => {
			image.is_stored_at__image_location = _.find(
				servicesImages,
				(serviceImage) => {
					return serviceImage.startsWith(image.is_stored_at__image_location);
				},
			);
		});

		return images;
	}

	_getImagesToPreload() {
		const preloaded = new Set(this.preloadedBuilds);
		const toPreload = new Set(this._getImages());
		for (const image of toPreload) {
			if (preloaded.has(image.is_stored_at__image_location.split('@')[0])) {
				toPreload.delete(image);
			}
		}
		return Array.from(toPreload);
	}

	async registry(
		registryUrl,
		endpoint,
		registryToken,
		headers,
		decodeJson,
		followRedirect,
		encoding?,
	) {
		headers = { ...headers };
		headers['Authorization'] = `Bearer ${registryToken}`;
		return await request({
			url: `https://${registryUrl}${endpoint}`,
			headers,
			json: decodeJson,
			simple: false,
			resolveWithFullResponse: true,
			followRedirect,
			encoding,
		});
	}

	async _getLayerSize(token, registryUrl, layerUrl) {
		// This gets an approximation of the layer size because:
		// * it is the size of the tar file, not the size of the contents of the tar file (the tar file is slightly larger);
		// * the gzip footer only gives the size % 32 so it will be incorrect for layers larger than 4GiB
		const headers = { Range: 'bytes=-4' };
		// request(...) will re-use the same headers if it gets redirected.
		// We don't want to send the registry token to s3 so we ask it to not follow
		// redirects and issue the second request manually.
		let response = await this.registry(
			registryUrl,
			layerUrl,
			token,
			headers,
			false,
			false,
			null,
		);
		if (response.statusCode === 206) {
			// no redirect, like in the devenv
		} else if ([301, 307].includes(response.statusCode)) {
			// redirect, like on production or staging
			response = await request({
				uri: response.headers.location,
				headers,
				resolveWithFullResponse: true,
				encoding: null,
			});
		} else {
			throw new Error(
				'Unexpected status code from the registry: ' + response.statusCode,
			);
		}
		return response.body.readUIntLE(0, 4);
	}

	_registryUrl(imageLocation) {
		// imageLocation: registry2.balena-cloud.com/v2/ad7cd3616b4e72ed51a5ad349e03715e@sha256:4c042f195b59b7d4c492e210ab29ab61694f490a69c65720a5a0121c6277ecdd
		const slashIndex = imageLocation.search('/');
		return `${imageLocation.substring(0, slashIndex)}`;
	}

	_imageManifestUrl(imageLocation) {
		// imageLocation: registry2.balena-cloud.com/v2/ad7cd3616b4e72ed51a5ad349e03715e@sha256:4c042f195b59b7d4c492e210ab29ab61694f490a69c65720a5a0121c6277ecdd
		const slashIndex = imageLocation.search('/');
		const atIndex = imageLocation.search('@');
		// 2 times v2: /v2/v2/.... this is expected
		return `/v2${imageLocation.substring(
			slashIndex,
			atIndex,
		)}/manifests/${imageLocation.substring(atIndex + 1)}`;
	}

	_layerUrl(imageLocation, layerDigest) {
		// imageLocation: registry2.balena-cloud.com/v2/ad7cd3616b4e72ed51a5ad349e03715e@sha256:4c042f195b59b7d4c492e210ab29ab61694f490a69c65720a5a0121c6277ecdd
		// layerDigest: sha256:cc8d3596dce73cd52b50b9f10a2e4a70eb9db0f7e8ac90e43088b831b72b8ee0
		const slashIndex = imageLocation.search('/');
		const atIndex = imageLocation.search('@');
		// 2 times v2: /v2/v2/.... this is expected
		return `/v2${imageLocation.substring(
			slashIndex,
			atIndex,
		)}/blobs/${layerDigest}`;
	}

	async _getApplicationImagesManifests(imagesLocations, registryToken) {
		return await Bluebird.map(
			imagesLocations,
			async (imageLocation: string) => {
				const { body: manifest } = await this.registry(
					this._registryUrl(imageLocation),
					this._imageManifestUrl(imageLocation),
					registryToken,
					{},
					true,
					true,
				);
				return { manifest, imageLocation };
			},
			{ concurrency: CONCURRENT_REQUESTS_TO_REGISTRY },
		);
	}

	async _getLayersSizes(manifests: Manifest[], registryToken) {
		const digests = new Set();
		const layersSizes = new Map();
		const sizeRequests: Array<{ imageLocation: string; layer: Layer }> = [];
		for (const manifest of manifests) {
			for (const layer of manifest.manifest.layers) {
				if (!digests.has(layer.digest)) {
					digests.add(layer.digest);
					sizeRequests.push({ imageLocation: manifest.imageLocation, layer });
				}
			}
		}
		await Bluebird.map(
			sizeRequests,
			async ({
				imageLocation,
				layer,
			}: {
				imageLocation: string;
				layer: Layer;
			}) => {
				const size = await this._getLayerSize(
					registryToken,
					this._registryUrl(imageLocation),
					this._layerUrl(imageLocation, layer.digest),
				);
				layersSizes.set(layer.digest, { size, compressedSize: layer.size });
			},
			{ concurrency: CONCURRENT_REQUESTS_TO_REGISTRY },
		);
		return layersSizes;
	}

	async _getApplicationSize() {
		const images = this._getImagesToPreload();
		const imagesLocations = _.map(images, 'is_stored_at__image_location');
		const registryToken = await this._getRegistryToken(imagesLocations);
		const manifests = await this._getApplicationImagesManifests(
			imagesLocations,
			registryToken,
		);
		const layersSizes = await this._getLayersSizes(manifests, registryToken);
		let extra = 0;
		for (const { imageLocation, manifest } of manifests) {
			const apiSize = _.find(images, {
				is_stored_at__image_location: imageLocation,
			})?.image_size;
			const size = _.sumBy(
				manifest.layers,
				(layer: Layer) => layersSizes.get(layer.digest).size,
			);
			if (apiSize !== undefined && apiSize > size) {
				// This means that at least one of the image layers is larger than 4GiB
				extra += apiSize - size;
				// Extra may be too large if several images share one or more layers larger than 4GiB.
				// Maybe we could try to be smarter and mark layers that are smaller than 4GiB as safe (when apiSize <= size).
				// If an "unsafe" layer is used in several images, we would add the extra space only once.
			}
		}
		return _.sumBy([...layersSizes.values()], 'size') + extra;
	}

	async _getSize() {
		const images = this._getImagesToPreload();
		if (images.length === 1) {
			// Only one image: we know its size from the api, no need to fetch the layers sizes.
			return images[0].image_size;
		}
		// More than one image: sum the sizes of all unique layers of all images to get the application size.
		// If we summed the size of each image it would be incorrect as images may share some layers.
		return await this._getApplicationSize();
	}

	async _getRequiredAdditionalSpace() {
		if (this.additionalSpace !== null) {
			return this.additionalSpace;
		}
		const size = Math.round((await this._getSize()) * 1.4);
		return Math.max(0, size - this.freeSpace!);
	}

	_supervisorLT7() {
		try {
			return compareVersions(this.supervisorVersion!, '7.0.0') === -1;
		} catch (e) {
			// Suppose the supervisor version is >= 7.0.0 when it is not valid semver.
			return false;
		}
	}

	_supervisorLT13() {
		try {
			return compareVersions(this.supervisorVersion!, '13.0.0') === -1;
		} catch (e) {
			// This module requires the supervisor image to be tagged.
			// The OS stopped tagging supervisor images at some point, and only
			// restarted on v2.89.13. This means there is a range of OS versions for which
			// supervisorVersion will be `null`.
			// If null, assume the version is below 13
			return true;
		}
	}

	_getRegistryToken(images) {
		return Bluebird.resolve(
			this.balena.request.send({
				// @ts-expect-error
				baseUrl: this.balena.pine.API_URL,
				url: '/auth/v1/token',
				qs: {
					service: this._registryUrl(images[0]),
					scope: images.map(
						(imageRepository) =>
							`repository:${imageRepository.substr(
								imageRepository.search('/') + 1,
							)}:pull`,
					),
				},
			}),
		)
			.get('body')
			.get('token');
	}

	async _fetchApplication() {
		const { appId } = this;
		if (this.application || !appId) {
			return;
		}
		return this._runWithSpinner(`Fetching application ${appId}`, async () => {
			const releaseFilter: PineFilter<Release> = {
				status: 'success',
			};
			if (this.commit === 'latest') {
				const { should_be_running__release } =
					await this.balena.models.application.get(appId, {
						$select: 'should_be_running__release',
					});
				// TODO: Add a check to error if the application is not tracking any release
				releaseFilter.id =
					(should_be_running__release as PineDeferred | null)!.__id;
			} else if (this.commit != null) {
				releaseFilter.commit = { $startswith: this.commit };
			}

			const application = await this.balena.models.application.get(appId, {
				$expand: {
					should_be_running__release: {
						$select: 'commit',
					},
					is_for__device_type: {
						$select: 'slug',
						$expand: {
							is_of__cpu_architecture: {
								$select: 'slug',
							},
						},
					},
					owns__release: {
						$select: ['id', 'commit', 'end_timestamp', 'composition'],
						$expand: {
							contains__image: {
								$select: ['image'],
								$expand: {
									image: {
										$select: ['image_size', 'is_stored_at__image_location'],
									},
								},
							},
						},
						$filter: releaseFilter,
						$orderby: [{ end_timestamp: 'desc' }, { id: 'desc' }],
					},
				},
			});
			this.setApplication(application);
		});
	}

	async _checkImage(image) {
		const ok = await isReadWriteAccessibleFile(image);
		if (!ok) {
			console.warn('The image must be a read/write accessible file');
		}
	}

	_pluralize(count, thing) {
		return `${count} ${thing}${count !== 1 ? 's' : ''}`;
	}

	_deviceTypeArch(slug: string) {
		const deviceType = this.deviceTypes?.find((dt) => {
			return dt.slug === slug;
		});
		if (deviceType === undefined) {
			throw new this.balena.errors.BalenaError(`No such deviceType: ${slug}`);
		}
		return deviceType.is_of__cpu_architecture[0].slug;
	}

	prepare() {
		return Bluebird.resolve(this._build()).then(async () => {
			// Check that the image is a writable file
			await this._runWithSpinner(
				'Checking that the image is a writable file',
				() => this._checkImage(this.image),
			);

			// Get a free tcp port and balena sdk settings
			const port = await this._runWithSpinner('Finding a free tcp port', () =>
				getPort(),
			);

			this.dockerPort = port;
			// Create the docker preloader container
			const container = await this._runWithSpinner(
				'Creating preloader container',
				() =>
					createContainer(
						this.docker,
						this.image,
						this.splashImage,
						this.dockerPort,
						this.proxy,
					),
			);
			this.container = container;
			await this._runWithSpinner('Starting preloader container', () =>
				this.container.start(),
			);

			await Bluebird.each(this.certificates, (certificate) => {
				return this.container.putArchive(
					tarfs.pack(path.dirname(certificate), {
						entries: [path.basename(certificate)],
					}),
					{
						path: '/usr/local/share/ca-certificates/',
						noOverwriteDirNonDir: true,
					},
				);
			});

			this._prepareErrorHandler();
			const stream = await this.container.attach({
				stream: true,
				stdout: true,
				stderr: true,
				stdin: true,
				hijack: true,
			});
			this.stdin = stream;
			this.docker.modem.demuxStream(stream, this.stdout, this.stderr);

			await Promise.all([
				this._getImageInfo(),
				this._fetchDeviceTypes(),
				this._fetchApplication(),
			]);
		});
	}

	cleanup() {
		// Returns Promise
		// Deletes the container
		return Bluebird.resolve(
			this._runWithSpinner('Cleaning up temporary files', async () => {
				if (this.container) {
					await Promise.all([this.kill(), this.container.wait()]);
					await this.container.remove();
				}
			}),
		);
	}

	kill() {
		// returns Promise
		if (this.container) {
			return this.container.kill().catch(() => undefined);
		}
		return Bluebird.resolve();
	}

	_ensureCanPreload() {
		// Throws a BalenaError if preloading is not possible
		let msg;

		// No releases
		if (this.application.owns__release.length === 0) {
			msg = 'This application has no successful releases';
			throw new this.balena.errors.BalenaError(msg);
		}

		// Don't preload if the image arch does not match the application arch
		if (this.dontCheckArch === false) {
			const imageArch = this._deviceTypeArch(this.config!.deviceType);
			const applicationArch =
				this.application.is_for__device_type[0].is_of__cpu_architecture[0].slug;
			if (
				!this.balena.models.os.isArchitectureCompatibleWith(
					imageArch,
					applicationArch,
				)
			) {
				msg = `Application architecture (${applicationArch}) and image architecture (${imageArch}) are not compatible.`;
				throw new this.balena.errors.BalenaError(msg);
			}
		}

		// Don't preload a multicontainer app on an image which supervisor version is older than 7.0.0
		if (this._getImages().length > 1 && this._supervisorLT7()) {
			msg = `Can't preload a multicontainer app on an image which supervisor version is < 7.0.0 (${this.supervisorVersion}).`;
			throw new this.balena.errors.BalenaError(msg);
		}

		// No new images to preload
		if (this._getImagesToPreload().length === 0) {
			msg = 'Nothing new to preload.';
			throw new this.balena.errors.BalenaError(msg);
		}
	}

	_getAppData() {
		if (this._supervisorLT7()) {
			if (this.pinDevice === true) {
				throw new this.balena.errors.BalenaError(
					'Pinning releases only works with supervisor versions >= 7.0.0',
				);
			}
			// Add an appId to each app from state v1 (the supervisor needs it)
			// rename environment -> env
			// rename image -> imageId
			// remove serviceId
			return _.map(this.state.local.apps, (value, appId) => {
				return _.merge(
					{},
					_.omit(value, ['environment', 'image', 'serviceId']),
					{ appId, env: value.environment, imageId: value.image },
				);
			});
		} else {
			return _.merge(_.omit(this.state.local, 'name'), {
				pinDevice: this.pinDevice,
			});
		}
	}

	/**
	 * Return the splash image path depending on the balenaOS version.
	 * (It was renamed from `resin-logo` to `balena-logo` in balenaOS v2.53.0.)
	 */
	_getSplashImagePath() {
		try {
			if (compareVersions(this.balenaOSVersion!, '2.53.0') >= 0) {
				return '/splash/balena-logo.png';
			}
		} catch (err) {
			// invalid semver (including the empty string, undefined or null)
		}
		return '/splash/resin-logo.png';
	}

	preload() {
		return Bluebird.resolve(this._getState()).then(async () => {
			this._ensureCanPreload();
			const additionalBytes = await this._runWithSpinner(
				'Estimating required additional space',
				() => this._getRequiredAdditionalSpace(),
			);
			const images = _.map(
				this._getImagesToPreload(),
				'is_stored_at__image_location',
			);
			// Wait for dockerd to start
			await this._runWithSpinner(
				'Resizing partitions and waiting for dockerd to start',
				() =>
					this._runCommand('preload', {
						app_data: this._getAppData(),
						additional_bytes: additionalBytes,
						splash_image_path: this._getSplashImagePath(),
					}),
			);
			const registryToken = await this._getRegistryToken(images);

			const opts = { authconfig: { registrytoken: registryToken } };
			// Docker connection
			// We use localhost on windows because of this bug in node < 8.10.0:
			// https://github.com/nodejs/node/issues/14900
			const innerDocker = new Docker({
				host: os.platform() === 'win32' ? 'localhost' : '0.0.0.0',
				port: this.dockerPort,
			});
			const innerDockerProgress = new dockerProgress.DockerProgress({
				docker: innerDocker,
			});
			const pullingProgressName = `Pulling ${this._pluralize(
				images.length,
				'image',
			)}`;
			// Emit progress events while pulling
			const onProgressHandlers = innerDockerProgress.aggregateProgress(
				images.length,
				(e) => {
					this._progress(pullingProgressName, e.percentage);
				},
			);
			await Bluebird.map(images, (image, index) => {
				return innerDockerProgress.pull(image, onProgressHandlers[index], opts);
			});

			// Signal that we're done to the Python script.
			this.stdin.write('\n');
			// Wait for the script to unmount the data partition
			await new Bluebird((resolve, reject) => {
				this.stdout.once('error', reject);
				this.stdout.once('data', resolve);
			});
		});
	}

	setApplication(application: Application) {
		this.appId = application.id;
		this.application = application;
	}

	/**
	 * @param {string | number} appIdOrSlug
	 * @param {string} commit
	 * @returns {Promise<void>}
	 */
	setAppIdAndCommit(appIdOrSlug: string | number, commit: string) {
		this.appId = appIdOrSlug;
		this.commit = commit;
		this.application = null;
		return Bluebird.resolve(this._fetchApplication());
	}
}
