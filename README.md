# resin-preload-image-script

Script for preloading resin device images with a user application container.

Using this will allow images with supervisor version above 1.0.0 to run the user application without connectivity, and without the need to download the container.

## Building from source

```bash
  docker build -t resin/resin-preload .
```

## Usage

This script requires the following environment variables to be set:
  * `IMAGE`: The path to the OS image to modify
  * `APP_ID`: ID of the App that will be assigned to the device. It can be extracted from the URL in the Resin dashboard, for instance `https://dashboard.resinstaging.io/apps/2167` means the `APP_ID` is `2167`.
  * `REGISTRY_HOST`: Docker registry from which to download the image. If unsure, use `registry.resin.io`.
  * `API_TOKEN`: Authentication token for Resin, taken from the [preferences page](https://dashboard.resinstaging.io/preferences?tab=details). Alternatively, you can use an `API_KEY` variable with an API key from a config.json file or the [SDK](https://github.com/resin-io/resin-sdk/blob/master/DOCUMENTATION.md#resin.models.application.getApiKey).
  * `API_HOST`: Address of the Resin API. If unsure, use `https://api.resin.io`.

## Example

Download a OS image from the Resin dashboard and then run with docker:

```bash
  export API_TOKEN=... # copy from dashboard preferences
  export APP_ID=... # id of your application (you can see it on dashboard URL when you visit your app page)
  export PATH_TO_IMAGE=/path/to/resin.img
  docker run -it -e API_TOKEN=$API_TOKEN -e APP_ID=$APP_ID -v $PATH_TO_IMAGE:/img/resin.img --privileged resin/resin-preload
```

The `/path/to/resin.img` file, will now have the latest version of your application preloaded.
