import { computeLayers, streamLayers, Layer } from './layers';
import { Pack } from 'tar-stream';
import axios from 'axios';
import { AxiosResponse } from 'axios';
import { pullManifestsFromRegistry } from './registry';
import { ExtendedManifests, Image } from './interface-manifest';

/**
 * PromisePacker
 * Promisify tar-stream.pack.entry ( https://www.npmjs.com/package/tar-stream )
 */

const promisePacker =
	(pack: Pack, injectFolder?: string) => (header: any, value: any) =>
		new Promise((resolve, reject) => {
			if (header.name.includes('sha256:')) {
				console.log(`=> FIXME!! pack header.name: ${header.name}`);
			}
			// add the root injectable folder in front of the name when injecting files
			if (injectFolder) {
				header.name = `${injectFolder}/${header.name}`;
			}
			pack.entry(header, value, (error: any) => {
				if (error) {
					reject(error);
				}
				resolve(true);
			});
		});

interface Assets {
	appsJson: any;
	manifests: ExtendedManifests[];
	layers: Layer[];
}

/** Prepare Assets for preloading, needs to be called before streamAssets and can be run in parallel with .etch stream of base os to prevent waiting */
const prepareAssets = async (
	supervisorVersion: string,
	arch: string,
	appId: string,
	api: string,
	token: string,
): Promise<Assets> =>
	new Promise(async (resolve, reject) => {
		try {
			// get apps.json
			// get apps uuid from id
			const uuid = await axios({
				url: `${api}/v6/application(${appId})`,
				headers: {
					'Content-Type': 'application/json',
					Authorization: `${token}`,
				},
			}).then((res: AxiosResponse) => res.data.d[0].uuid);

			const appsJson: any = await axios({
				url: `${api}/device/v3/fleet/${uuid}/state`,
				headers: {
					'Content-Type': 'application/json',
					Authorization: `${token}`,
				},
			}).then((res: AxiosResponse) => res.data[uuid]);

			// extract image_ids from appsJson
			// TODO: prepare for multiapps and loop on apps instead of getting only the one declared

			const releaseId = Object.keys(appsJson.apps?.[uuid]?.releases)[0];

			const imageKeys = Object.keys(
				appsJson.apps?.[uuid]?.releases?.[releaseId]?.services,
			);

			console.log('imageKeys', imageKeys);

			const imageNames = imageKeys.map(
				(key) =>
					appsJson.apps?.[uuid]?.releases?.[releaseId]?.services[key].image,
			);

			const images = imageNames.map((image): Image => {
				const [imageName, imageHash] = image.split('@');
				return {
					imageName,
					imageHash,
				};
			});

			// FIXME: BROKEN ON BOB BECAUSE WE CANNOT GET THE SV FROM BOB's API
			// We need to replace the balena-cloud.com part of the url with the api var before going to prod
			// get the supervisor image
			// NB: Once HostApps are ready, SV (along with potential other) will be listed in `target state v3` / `apps.json`
			const { data } = await axios({
				headers: {
					Authorization: token!,
					ContentType: 'application/json',
				},
				// url: `${api}/v6/supervisor_release?\$top=1&\$select=image_name&\$filter=(supervisor_version%20eq%20%27${supervisorVersion}%27)%20and%20(is_for__device_type/any(ifdt:ifdt/is_of__cpu_architecture/any(ioca:ioca/slug%20eq%20%27${arch}%27)))`,
				url: `https://api.balena-cloud.com/v6/supervisor_release?\$top=1&\$select=image_name&\$filter=(supervisor_version%20eq%20%27${supervisorVersion}%27)%20and%20(is_for__device_type/any(ifdt:ifdt/is_of__cpu_architecture/any(ioca:ioca/slug%20eq%20%27${arch}%27)))`,
			});

			const superVisorImage = [
				{
					imageName: data.d[0].image_name,
					imageHash: 'latest',
					isSupervisor: true,
					supervisorVersion,
				},
			];

			// get image manifests for all images (supervisor + apps)
			const manifests: ExtendedManifests[] = [];
			console.log(`== Downloading Manifests @getManifests ==`);
			for (const image in [...superVisorImage, ...images]) {
				if (Object.prototype.hasOwnProperty.call(images, image)) {
					const imageName = images[image].imageName;
					const isSupervisor = images[image].isSupervisor;
					console.log(
						`=> ${parseInt(image, 10) + 1} / ${images.length} : ${imageName}`,
					);
					const manifestInfo = await pullManifestsFromRegistry(
						imageName,
						api,
						token,
						!!isSupervisor,
					);
					manifests.push({
						...manifestInfo,
						...images[image],
					});
				}
			}
			console.log(`== Downloading Manifests @getManifests DONE ==`);

			// precompute layers metadata for all layers
			const layers = await computeLayers(manifests);

			resolve({ appsJson, manifests, layers });

			console.log('==> STARTING @prepareAssets');
		} catch (error) {
			console.log(`== Prepare Assets Failed == ${error}`);
			reject();
		}
	});

/** Stream Preloading assets prepared at previous stage, needs to be done AFTER prepare on a dotech stream with base image already streamed (cf readme) */
const streamAssets = async (
	packStream: Pack,
	dataPartition: number,
	manifests: ExtendedManifests[],
	layers: Layer[],
	appsJson: any,
): Promise<void> =>
	new Promise(async (resolve, reject) => {
		try {
			console.log('==> STARTING @streamPreloadAssets');

			// prepare packer :
			const injectPath = `inject/${dataPartition}`;
			const packFile = promisePacker(packStream, injectPath); // promise

			// download and process layers
			// this is where most of the work is happening
			// will stream content of the layers directly to packStream
			// everything before this point can be parallelise with streaming the base image
			// this step MUST be right AFTER the base image stream is done
			// will return a bunch of file to inject later (all the generated metadata file)
			const layersFilesToInject = await streamLayers(
				manifests,
				layers,
				packStream,
				injectPath,
			);

			// prepare images files to inject (same as for layers but for images)
			const dockerImageOverlay2Imagedb = 'docker/image/overlay2/imagedb';
			const imagesFilesToInject = manifests
				.map(({ configManifestV2, imageId }: any) => {
					const shortImageId = imageId.split(':')[1];
					return [
						{
							header: {
								name: `${dockerImageOverlay2Imagedb}/content/sha256/${shortImageId}`,
								mode: 644,
							},
							content: JSON.stringify(configManifestV2),
						},
						{
							header: {
								name: `${dockerImageOverlay2Imagedb}/metadata/sha256/${shortImageId}/lastUpdated`,
								mode: 644,
							},
							content: new Date().toISOString(),
						},
					];
				})
				.flat();

			/**
			 * generate repositories.json snipets for each images, merge everything and prepare file to be injected
			 * /var/lib/docker/image/overlay2/repositories.json
			 * That file informs balena-engine of what images are availble in its local store
			 * and maps images name(s) (including tag) to an image digest.
			 *
			 * Here we generate a complete repositories.json for all the preloaded images, including the supervisor.
			 *
			 * We will overwrite the orignal repositories.json which has been created at the balenaos build.
			 *
			 * One small difference between the original and the one we create is that we don't tag the supevisor with its hash.
			 * Which shouldn't have any impact, but is worth noting "au cas où"
			 *
			 * Relative path of repositories.json as injected in the resin-data partition
			 * On a running device it would be /var/lib/docker/image/overlay2/repositories.json
			 */

			const repositories: any = {};
			for (const {
				imageId,
				imageName,
				imageHash,
				isSupervisor,
				supervisorVersion,
			} of manifests) {
				// prepare repositories
				repositories[imageName] = {
					[`${imageName}:latest`]: `sha256:${imageId}`,
				};
				if (imageHash !== 'latest') {
					repositories[imageName][
						`${imageName}:@${imageHash}`
					] = `sha256:${imageId}`;
				}

				if (isSupervisor) {
					repositories['balena_supervisor'] = {
						[`balena_supervisor:${supervisorVersion}`]: imageId,
					};
				}
			}

			// prepare other metadata files
			const generalFilesToInject = [
				{
					header: {
						name: 'docker/image/overlay2/repositories.json',
						mode: 644,
					},
					content: JSON.stringify({
						Repositories: repositories,
					}),
				},
				{
					header: { name: 'apps.json', mode: 644 },
					content: JSON.stringify(appsJson),
				},
			];

			console.log('---> Add meta files and folders');
			// inject all metadata files and folders
			// one at a time on the stream
			for (const { header, content } of [
				...layersFilesToInject,
				...imagesFilesToInject,
				...generalFilesToInject,
			]) {
				await packFile(header, content);
			}

			// we're done with the preload assets
			console.log('==> FINISHED @streamPreloadAssets');

			resolve();
		} catch (error) {
			console.log("couldn't make assets", error);
			reject();
		}
	});

const streamPreload = { streamAssets, prepareAssets };

export { streamPreload };
