# resin-preload-image-script

Script for preloading resin device images with a user application container.

Using this will allow images with supervisor version above 1.0.0 to run the user application without connectivity, and without the need to download the container.

## System requirements
Tested on Ubuntu 14.04.

Requires the following executables:
  * curl
  * jq
  * docker
  * losetup
  * partprobe
  * bash
  * btrfs

## Usage

This script requires the following environment variables to be set:
  * `IMAGE`: The path to the OS image to modify
  * `APP_ID`: ID of the App that will be assigned to the device. It can be extracted from the URL in the Resin dashboard, for instance `https://dashboard.resinstaging.io/apps/2167` means the `APP_ID` is `2167`.
  * `REGISTRY_HOST`: Docker registry from which to download the image. If unsure, use `registry.resin.io`.
  * `API_TOKEN`: Authentication token for Resin, taken from the [preferences page](https://dashboard.resinstaging.io/preferences?tab=details). Alternatively, you can use an `API_KEY` variable with an API key from a config.json file.
  * `API_HOST`: Address of the Resin API. If unsure, use `https://api.resin.io`.

## Example

Download a OS image from the Resin dashboard and then:

```bash
  # The last 1.0.1 here specifies the supervisor version
  export IMAGE=/home/user/resin-testapplication-0.1.0-1.0.1-b5327808f40f.img
  export APP_ID=3759
  export REGISTRY_HOST=registry.resin.io
  export API_TOKEN=lotsofjibberjabberextractedfromtheresindashboard
  export API_HOST=https://api.resin.io
  sudo -e ./preload.sh # The -e ensures that the env variables are exported through sudo
```
After running this, the `resin-testapplication-0.1.0-1.0.1-b5327808f40f.img` file will include the latest app container for the app with ID `3759`.
