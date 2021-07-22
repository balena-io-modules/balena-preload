const _ = require('lodash');
const EventEmitter = require('events');
const dockerProgress = require('docker-progress');
const Docker = require('dockerode');
const path = require('path');
const streamModule = require('stream');
const Bluebird = require('bluebird');
const tarfs = require('tar-fs');
const fs = Bluebird.promisifyAll(require('fs'));
const getPort = require('get-port');
const os = require('os');
const tmp = require('tmp-promise');
const unzipper = require('unzipper');
const archiver = require('archiver');
const getFolderSizeAsync = Bluebird.promisify(require('get-folder-size'));
const compareVersions = require('compare-versions');
const request = require('request-promise');

const preload = module.exports;

const { R_OK, W_OK } = fs.constants;

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

const PARTITION_NAMES = ['resin-boot', 'resin-rootA', 'resin-data'];
const SUPERVISOR_USER_AGENT =
	'Supervisor/v6.6.0 (Linux; Resin OS 2.12.3; prod)';

const FLASH_EDISON_FILENAME = 'FlashEdison.json';
const EDISON_PARTITION_FILE_KEYS = {
	'resin-boot': 'boot_file',
	'resin-rootA': 'rootfs_file',
	'resin-data': 'resin-data_file',
};

const getEdisonPartitions = (edisonFolder) => {
	// The replace is needed because this file contains new lines in strings, which is not valid JSON.
	const data = JSON.parse(
		fs
			.readFileSync(path.join(edisonFolder, FLASH_EDISON_FILENAME), 'utf8')
			.replace(/\n/g, ''),
	);
	const parameters = data.flash.parameters;
	const result = {};
	PARTITION_NAMES.forEach((name) => {
		result[name] = {
			file: path.join(
				edisonFolder,
				parameters[EDISON_PARTITION_FILE_KEYS[name]].value,
			),
			image: `/img/${name}`,
		};
	});
	return result;
};

class BufferBackedWritableStream extends streamModule.Writable {
	chunks = [];

	_write(chunk, _enc, next) {
		this.chunks.push(chunk);
		next();
	}

	getData() {
		return Buffer.concat(this.chunks);
	}
}

const bindMount = (source, target, dockerApiVersion) => {
	source = path.resolve(source);
	if (compareVersions(dockerApiVersion, '1.25') >= 0) {
		return {
			Source: source,
			Target: target,
			Type: 'bind',
			Consistency: 'delegated',
		};
	} else {
		return `${source}:${target}`;
	}
};

const zipContainsFiles = (archive, files) => {
	// FIXME: read from the zip directory instead of reading the whole file
	// This is broken in unzipper for now: an invalid zip file will throw an
	// uncaught error event.
	const filesCopy = files.slice();
	return new Bluebird((resolve, reject) => {
		fs.createReadStream(archive)
			.on('error', reject)
			.pipe(unzipper.Parse())
			.on('error', reject)
			.on('entry', function (entry) {
				_.pull(filesCopy, entry.path);
				entry.autodrain();
			})
			.on('finish', () => {
				resolve(filesCopy.length === 0);
			});
	});
};

const isEdisonZipArchive = (file) => {
	return zipContainsFiles(file, [FLASH_EDISON_FILENAME]).catchReturn(false);
};

const createContainer = (
	docker,
	image,
	splashImage,
	dockerPort,
	proxy,
	edisonFolder,
) => {
	const mounts = [];
	return docker.version().then((version) => {
		if (os.platform() === 'linux') {
			// In some situations, devices created by `losetup -f` in the container only appear on the host and not in the container.
			// See https://github.com/balena-io/balena-cli/issues/1008
			mounts.push(bindMount('/dev', '/dev', version.ApiVersion));
		}
		if (splashImage) {
			mounts.push(
				bindMount(splashImage, SPLASH_IMAGE_PATH_IN_DOCKER, version.ApiVersion),
			);
		}

		const env = [
			`HTTP_PROXY=${proxy || ''}`,
			`HTTPS_PROXY=${proxy || ''}`,
			`DOCKER_PORT=${dockerPort || ''}`,
			`DOCKER_TMPDIR=${DOCKER_TMPDIR}`,
		];

		if (edisonFolder) {
			const partitions = getEdisonPartitions(edisonFolder);
			env.push(`PARTITIONS=${JSON.stringify(partitions)}`);
			PARTITION_NAMES.forEach((name) => {
				const part = partitions[name];
				mounts.push(bindMount(part.file, part.image, version.ApiVersion));
			});
		} else {
			mounts.push(
				bindMount(image, DISK_IMAGE_PATH_IN_DOCKER, version.ApiVersion),
			);
		}
		const containerOptions = {
			Image: DOCKER_IMAGE_TAG,
			Name: preload.CONTAINER_NAME,
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
		containerOptions.HostConfig[
			compareVersions(version.ApiVersion, '1.25') >= 0 ? 'Mounts' : 'Binds'
		] = mounts;
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
		return docker.createContainer(containerOptions);
	});
};

const isReadWriteAccessibleFile = (image) => {
	return Bluebird.join(
		// tslint:disable-next-line:no-bitwise
		fs.promises.access(image, R_OK | W_OK),
		fs.promises.stat(image),
		(_void, stats) => {
			return stats.isFile();
		},
	).catchReturn(false);
};

class Preloader extends EventEmitter {
	constructor(
		balena,
		docker,
		appId,
		commit,
		image,
		splashImage,
		proxy,
		dontCheckArch,
		pinDevice = false,
		certificates = [],
		additionalSpace = null,
	) {
		super();
		if (balena == null) {
			balena = require('balena-sdk').fromSharedOptions();
		}

		this.balena = balena;
		this.docker = docker;
		this.appId = appId;
		this.commit = commit;
		this.image = image;
		this.splashImage = splashImage;
		this.proxy = proxy;
		this.dontCheckArch = dontCheckArch;
		this.pinDevice = pinDevice;
		this.certificates = certificates;
		this.additionalSpace = additionalSpace;
		this.application = null;
		this.stdin = null;
		this.stdout = new streamModule.PassThrough();
		this.stderr = new streamModule.PassThrough();
		this.bufferedStderr = new BufferBackedWritableStream();
		this.stderr.pipe(this.bufferedStderr); // TODO: split stderr and build output ?
		this.edisonFolder = null;
		this.dockerPort = null;
		this.container = null;
		this.tmpCleanup = null;
		this.balenaSettings = null;
		this.token = null;
		this.state = null; // device state from the api
		this.freeSpace = null; // space available on the image data partition (in bytes)
		this.preloadedBuilds = null; // list of preloaded Docker images in the disk image
		this.supervisorVersion = null; // disk image supervisor version
		this.balenaOSVersion = null; // OS version from the image's "/etc/issue" file
		this.config = null; // config.json data from the disk image
		this.deviceTypes = null;
	}

	/**
	 * Build the preloader docker image
	 * @returns Promise
	 */
	_build() {
		const files = ['Dockerfile', 'requirements.txt', 'src/preload.py'];
		const name = 'Building Docker preloader image.';
		this._progress(name, 0);

		const tarStream = tarfs.pack(path.resolve(__dirname, '..'), {
			entries: files,
		});
		return this.docker
			.buildImage(tarStream, { t: DOCKER_IMAGE_TAG })
			.then((build) => {
				return new Bluebird((resolve, reject) => {
					this.docker.modem.followProgress(
						build,
						(error) => {
							// onFinished
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
										(parseInt(matches[1], 10) /
											(parseInt(matches[2], 10) + 1)) *
											100,
									);
								}
								this.stderr.write(event.stream);
							}
						},
					);
				});
			});
	}

	_fetchDeviceTypes() {
		return Bluebird.resolve(this.balena.models.config.getDeviceTypes()).tap(
			(dt) => {
				this.deviceTypes = dt;
			},
		);
	}

	_unzipFiles(archive, folder) {
		// archive is the path to a zip file
		const name = 'Unzipping Edison zip archive';
		let position = 0;
		this._progress(name, 0);
		return Bluebird.resolve(fs.promises.stat(archive)).then((stat) => {
			return fs
				.createReadStream(archive)
				.on('data', (buf) => {
					position += buf.length;
					this._progress(name, (position / stat.size) * 100);
				})
				.pipe(unzipper.Extract({ path: folder }))
				.promise();
		});
	}

	_zipFolder(folder, destination) {
		const name = 'Zipping back files into Edison zip archive';
		let position = 0;
		this._progress(name, 0);
		return getFolderSizeAsync(folder).then((size) => {
			return new Bluebird((resolve, reject) => {
				const archive = archiver('zip', { zlib: { level: 9 } });
				archive.on('warning', console.warn);
				archive.on('error', reject);
				archive.on('entry', (entry) => {
					position += entry.stats.size;
					this._progress(name, (position / size) * 100);
				});
				archive.directory(folder, false);
				archive.finalize();
				const output = fs.createWriteStream(destination);
				output.on('error', reject);
				output.on('close', () => {
					this._progress(name, 100);
					resolve();
				});
				archive.pipe(output);
			});
		});
	}

	_runWithSpinner(name, fn) {
		this._startSpinner(name);
		return fn().finally(() => {
			this._stopSpinner(name);
		});
	}

	_prepareErrorHandler() {
		// Emit an error event if the python script exits with an error
		this.container
			.wait()
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
						// @ts-ignore
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
	 *
	 * @param {string} command
	 * @param {object} parameters
	 */
	_runCommand(command, parameters) {
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
				let response = {};
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

	_getState() {
		const uuid = this.balena.models.device.generateUniqueKey();
		return Bluebird.resolve(
			this.balena.models.device.register(this.appId, uuid),
		)
			.then((deviceInfo) => {
				return this.balena.pine.patch({
					resource: 'device',
					id: deviceInfo.id,
					body: {
						should_be_running__release: this._getRelease().id,
					},
				});
			})
			.then(() => {
				return this.balena.request.send({
					headers: { 'User-Agent': SUPERVISOR_USER_AGENT },
					baseUrl: this.balena.pine.API_URL,
					url: `device/v${this._supervisorLT7() ? 1 : 2}/${uuid}/state`,
				});
			})
			.get('body')
			.then((state) => {
				this.state = state;
				return this.balena.models.device.remove(uuid);
			});
	}

	_getImageInfo() {
		// returns Promise<object> (device_type, preloaded_builds, free_space and config)
		return this._runWithSpinner('Reading image information', () => {
			return this._runCommand('get_image_info', {}).tap((info) => {
				this.freeSpace = info.free_space;
				this.preloadedBuilds = info.preloaded_builds;
				this.supervisorVersion = info.supervisor_version;
				this.balenaOSVersion = info.balena_os_version;
				this.config = info.config;
			});
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

	_getImages() {
		// This method lists the images that need to be preloaded.
		// The is_stored_at__image_location attribute must match the image attribute of the app or app service in the state endpoint.
		// List images from the release.
		const images = this._getRelease().contains__image.map((ci) => {
			return _.merge({}, ci.image[0], {
				is_stored_at__image_location:
					ci.image[0].is_stored_at__image_location.toLowerCase(),
			});
		});
		// App from the state endpoint (v1 or v2 depending on the supervisor version).
		const app = _.values(this.state.local.apps)[0];
		if (this._supervisorLT7()) {
			// Pre-multicontainer: there is only one image: use the only image from the state endpoint.
			images[0].is_stored_at__image_location = app.image.toLowerCase();
		} else {
			// Multicontainer: we need to match is_stored_at__image_location with service.image from the state v2 endpoint.
			const servicesImages = _.map(app.services, (service) => {
				return service.image.toLowerCase();
			});
			_.each(images, (image) => {
				image.is_stored_at__image_location = _.find(
					servicesImages,
					(serviceImage) => {
						return serviceImage.startsWith(image.is_stored_at__image_location);
					},
				);
			});
		}
		return images;
	}

	_getImagesToPreload() {
		const preloaded = new Set(this.preloadedBuilds);
		const toPreload = new Set(this._getImages());
		for (let image of toPreload) {
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
		encoding,
	) {
		headers = { ...headers };
		headers['Authorization'] = `Bearer ${registryToken}`;
		return await request({
			url: `https://${registryUrl}${endpoint}`,
			headers: headers,
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
			async (imageLocation) => {
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

	async _getLayersSizes(manifests, registryToken) {
		const digests = new Set();
		const layersSizes = new Map();
		const sizeRequests = [];
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
			async ({ imageLocation, layer }) => {
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
			}).image_size;
			const size = _.sumBy(
				manifest.layers,
				(layer) => layersSizes.get(layer.digest).size,
			);
			if (apiSize > size) {
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
		return Math.max(0, size - this.freeSpace);
	}

	_supervisorLT7() {
		try {
			return compareVersions(this.supervisorVersion, '7.0.0') === -1;
		} catch (e) {
			// Suppose the supervisor version is >= 7.0.0 when it is not valid semver.
			return false;
		}
	}

	_getRegistryToken(images) {
		return Bluebird.resolve(
			this.balena.request.send({
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

	_fetchApplication() {
		if (this.application || !this.appId) {
			return Bluebird.resolve();
		}
		return this._runWithSpinner(`Fetching application ${this.appId}`, () => {
			const releaseFilter = {
				status: 'success',
			};
			return Bluebird.try(() => {
				if (this.commit === 'latest') {
					return this.balena.models.application
						.get(this.appId, {
							$select: 'should_be_running__release',
						})
						.then(({ should_be_running__release: { __id } }) => {
							releaseFilter.id = __id;
						});
				} else if (this.commit != null) {
					releaseFilter.commit = { $startswith: this.commit };
				}
			})
				.then(() => {
					return this.balena.models.application.get(this.appId, {
						$expand: {
							should_be_running__release: {
								$select: 'commit',
							},
							is_for__device_type: {
								$select: 'slug',
							},
							owns__release: {
								$select: ['id', 'commit', 'end_timestamp', 'composition'],
								$orderby: [{ end_timestamp: 'desc' }, { id: 'desc' }],
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
							},
						},
					});
				})
				.then((application) => {
					this.setApplication(application);
				});
		});
	}

	_checkImage(image) {
		return isReadWriteAccessibleFile(image).then((ok) => {
			if (!ok) {
				console.warn('The image must be a read/write accessible file');
			}
		});
	}

	_pluralize(count, thing) {
		return `${count} ${thing}${count !== 1 ? 's' : ''}`;
	}

	_deviceTypeArch(slug) {
		const deviceType = _.find(this.deviceTypes, (dt) => {
			return dt.slug === slug;
		});
		if (deviceType === undefined) {
			throw new this.balena.errors.BalenaError(`No such deviceType: ${slug}`);
		}
		return deviceType.arch;
	}

	prepare() {
		return this._build()
			.then(() => {
				// Check that the image is a writable file
				return this._runWithSpinner(
					'Checking that the image is a writable file',
					() => {
						return this._checkImage(this.image);
					},
				);
			})
			.then(() => {
				// Get a free tcp port and balena sdk settings
				return this._runWithSpinner(
					'Finding a free tcp port and getting balena settings',
					() => {
						return Bluebird.all([
							getPort(),
							this.balena.settings.getAll(),
							this.balena.auth.getToken(),
						]);
					},
				);
			})
			.then(([port, balenaSettings, token]) => {
				this.dockerPort = port;
				this.balenaSettings = balenaSettings;
				this.token = token;
				// Check if the image is a regular disk image or an Edison zip archive
				return this._runWithSpinner(
					'Checking if the image is an edison zip archive',
					() => {
						return isEdisonZipArchive(this.image);
					},
				);
			})
			.then((isEdison) => {
				// If the image is an Edison zip archive extract it to a temporary folder.
				if (isEdison) {
					const tmpDirOptions = { unsafeCleanup: true };
					if (os.platform() === 'darwin') {
						// Docker on mac can not access /var/folders/... by default which is where $TMPDIR is on macos.
						// https://docs.docker.com/docker-for-mac/osxfs/#namespaces
						tmpDirOptions.dir = '/tmp';
					}
					return tmp.dir(tmpDirOptions).then(({ path: folder, cleanup }) => {
						this.edisonFolder = folder;
						this.tmpCleanup = cleanup;
						return this._unzipFiles(this.image, folder);
					});
				}
			})
			.then(() => {
				// Create the docker preloader container
				return this._runWithSpinner('Creating preloader container', () => {
					return createContainer(
						this.docker,
						this.image,
						this.splashImage,
						this.dockerPort,
						this.proxy,
						this.edisonFolder,
					);
				});
			})
			.then((container) => {
				this.container = container;
				return this._runWithSpinner('Starting preloader container', () => {
					return this.container.start();
				});
			})
			.then(() => {
				return Bluebird.each(this.certificates, (certificate) => {
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
			})
			.then(() => {
				this._prepareErrorHandler();
				return this.container.attach({
					stream: true,
					stdout: true,
					stderr: true,
					stdin: true,
				});
			})
			.then((stream) => {
				this.stdin = stream;
				this.docker.modem.demuxStream(stream, this.stdout, this.stderr);
			})
			.then(() => {
				return this._fetchDeviceTypes();
			})
			.then(() => {
				return this._fetchApplication();
			})
			.then(() => {
				return this._getImageInfo();
			});
	}

	cleanup() {
		// Returns Promise
		// Deletes the container and the temporary edison folder if it was created
		return this._runWithSpinner('Cleaning up temporary files', () => {
			return Bluebird.try(() => {
				if (this.container) {
					return Bluebird.all([this.kill(), this.container.wait()]).then(() => {
						return this.container.remove();
					});
				}
			}).then(() => {
				if (this.tmpCleanup) {
					return this.tmpCleanup();
				}
			});
		});
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
			const imageArch = this._deviceTypeArch(this.config.deviceType);
			const applicationArch = this._deviceTypeArch(
				this.application.is_for__device_type[0].slug,
			);
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
			if (compareVersions(this.balenaOSVersion, '2.53.0') >= 0) {
				return '/splash/balena-logo.png';
			}
		} catch (err) {
			// invalid semver (including the empty string, undefined or null)
		}
		return '/splash/resin-logo.png';
	}

	preload() {
		let images;
		return this._getState()
			.then(() => {
				this._ensureCanPreload();
				return this._runWithSpinner(
					'Estimating required additional space',
					() => {
						return this._getRequiredAdditionalSpace();
					},
				);
			})
			.then((additionalBytes) => {
				images = _.map(
					this._getImagesToPreload(),
					'is_stored_at__image_location',
				);
				// Wait for dockerd to start
				return this._runWithSpinner(
					'Resizing partitions and waiting for dockerd to start',
					() => {
						return this._runCommand('preload', {
							app_data: this._getAppData(),
							additional_bytes: additionalBytes,
							splash_image_path: this._getSplashImagePath(),
						});
					},
				);
			})
			.then(() => {
				return this._getRegistryToken(images);
			})
			.then((registryToken) => {
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
				return Bluebird.map(images, (image, index) => {
					return innerDockerProgress.pull(
						image,
						onProgressHandlers[index],
						opts,
					);
				});
			})
			.then(() => {
				// Signal that we're done to the Python script.
				this.stdin.write('\n');
				// Wait for the script to unmount the data partition
				return new Bluebird((resolve, reject) => {
					this.stdout.once('error', reject);
					this.stdout.once('data', resolve);
				});
			})
			.then(() => {
				if (this.edisonFolder) {
					return this._zipFolder(this.edisonFolder, this.image);
				}
			});
	}

	setApplication(application) {
		this.appId = application.id;
		this.application = application;
	}

	/**
	 * @param {string | number} appId
	 * @param {string} commit
	 * @returns {Promise<void>}
	 */
	setAppIdAndCommit(appId, commit) {
		this.appId = appId;
		this.commit = commit;
		this.application = null;
		return this._fetchApplication();
	}
}

preload.Preloader = Preloader;

/** @const {String} Container name */
preload.CONTAINER_NAME = 'balena-image-preloader';

preload.applicationExpandOptions = {
	owns__release: {
		$select: ['id', 'commit', 'end_timestamp', 'composition'],
		$orderby: [{ end_timestamp: 'desc' }, { id: 'desc' }],
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
	},
};
