# resin-preload-image-script

Script for preloading resin.io OS images (`.img`) with a user application container.

Using this will allow images with supervisor version above 1.0.0 to run the user application without connectivity, and without the need to download the container.

## Known Issues

### Version Compatibility

This version will only work for Resin OS versions 1.2 and later.
For versions earlier than 1.2 you will need to checkout commit `5d6d4607bffc98acdf649ce5328e2079dfb9c3d9` of this repo and then follow the steps below. 

### BTRFS Support

Since Docker for Mac removed support for the BTRFS storage driver (see [docker/for-mac/issues/388](https://github.com/docker/for-mac/issues/388)), preloading images prior to Resin OS 2.0 will require the older [Docker toolbox](https://docs.docker.com/toolbox/toolbox_install_mac/) setup with [VirtualBox](https://www.virtualbox.org/) to function properly.

## Building from source

```bash
  docker build -t resin/resin-preload .
```

## Usage

This script requires the following environment variables to be set:
  * `IMAGE`: The path to the OS image you downloaded for the APP you want to target.
  * `APP_ID`: ID of the App that will be assigned to the device. It can be extracted from the URL in the Resin dashboard, for instance `https://dashboard.resin.io/apps/2167` means the `APP_ID` is `2167`.
  * `API_TOKEN`: Authentication token for Resin, taken from the [preferences page](https://dashboard.resin.io/preferences?tab=details). 

**Note:** Before running the example below, make sure that you have successfully pushed to the APP and that the `Application commit` is the correct version of the code you intend to preload.

## Example

Download a OS image from the Resin dashboard and then run with docker:

```bash
  export API_TOKEN=... # copy from dashboard preferences
  export APP_ID=... # id of your application (you can see it on dashboard URL when you visit your app page)
  export PATH_TO_IMAGE=/path/to/resin.img
  docker run -it -e API_TOKEN=$API_TOKEN -e APP_ID=$APP_ID -v $PATH_TO_IMAGE:/img/resin.img --privileged resin/resin-preload
```

The `/path/to/resin.img` file, will now have the latest version of your application preloaded.

## Additional Options
* `REGISTRY_HOST`: Docker registry from which to download the image. If unsure, use `registry.resin.io`.
* Alternatively to `API_TOKEN`, you can use an `API_KEY` variable with an API key from a config.json file or the [SDK](https://github.com/resin-io/resin-sdk/blob/master/DOCUMENTATION.md#resin.models.application.getApiKey).
* `API_HOST`: Address of the Resin API. If unsure, use `https://api.resin.io`.
