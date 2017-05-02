# resin-preload-image-script

Script for preloading resin.io OS images (`.img`) with a user application container.

Using this will allow images with supervisor version above 1.0.0 to run the user application without connectivity, and without the need to download the container.

<!-- MarkdownTOC -->

- [Usage](#usage)
  - [Example](#example)
- [Additional Options](#additional-options)
  - [Building from source](#building-from-source)
- [Requirements](#requirements)
  - [Linux](#linux)
  - [Mac](#mac)
  - [Windows](#windows)
- [Known Issues](#known-issues)
  - [Version Compatibility](#version-compatibility)
  - [BTRFS Support](#btrfs-support)

<!-- /MarkdownTOC -->

## Usage

```
Usage: preload.sh [options]

Options:

  --app          Application ID (required)
  --img          Disk image to preload into (required)
  --api-token    API token (required)
  --api-key      API key
  --api-host     API hostname
  --registry     Image registry host

Environment variables:

  The following option flags can also be set
  via the corresponding environment variables:

  --app          APP_ID
  --img          IMAGE
  --api-token    API_TOKEN
  --api-key      API_KEY
  --api-host     API_HOST
  --registry     REGISTRY_HOST

Example:

  preload.sh --app 123456 --api-token "xxxx..." --img /path/to/resin-os.img

```

This script requires the following options to be set:

  * `IMAGE`: The path to the OS image you downloaded for the `APP_ID` you want to target.
  * `APP_ID`: ID of the App that will be assigned to the device. It can be extracted from the URL in the Resin dashboard, for instance `https://dashboard.resin.io/apps/2167` means the `APP_ID` is `2167`.
  * `API_TOKEN`: Authentication token for Resin, taken from the [preferences page](https://dashboard.resin.io/preferences?tab=details). 


### Example

**NOTE:** Before running the example below, make sure that you have successfully pushed to the app and that the `Application commit` is the correct version of the code you intend to preload.

Download a OS image from the Resin dashboard and then run with docker:

1) Using option flags for configuration:

```bash
./preload.sh --app 123456 --api-token "XXX..." --img /path/to/resin.img
```

2) Using environment variables for configuration:

```bash
# Set the environment variables
export API_TOKEN=... # copy from dashboard preferences
export APP_ID=... # id of your application (you can see it on dashboard URL when you visit your app page)
export IMAGE=/path/to/resin.img

# As all required options have been set via environment variables,
# there's no need to pass any options, just run
./preload.sh
```

The `/path/to/resin.img` file, will now have the latest version of your application preloaded.

## Additional Options

* `REGISTRY_HOST`: Docker registry from which to download the image. If unsure, use `registry.resin.io`.
* Alternatively to `API_TOKEN`, you can use an `API_KEY` variable with an API key from a config.json file or the [SDK](https://github.com/resin-io/resin-sdk/blob/master/DOCUMENTATION.md#resin.models.application.getApiKey).
* `API_HOST`: Address of the Resin API. If unsure, use `https://api.resin.io`.

### Building from source

```bash
  docker build -t resin/resin-preload .
```

## Requirements

### Linux

- [Docker](https://www.docker.com)

### Mac

- [Docker for Mac](https://www.docker.com/docker-mac)

### Windows

- [Git](https://git-scm.com)
- [Docker for Windows](https://www.docker.com/docker-windows)

## Known Issues

### Version Compatibility

This version will only work for Resin OS versions 1.2 and later.
For versions earlier than 1.2 you will need to checkout commit `5d6d4607bffc98acdf649ce5328e2079dfb9c3d9` of this repo and then follow the steps below. 

### BTRFS Support

Since Docker for Mac / Windows removed support for the BTRFS storage driver (see [docker/for-mac/issues/388](https://github.com/docker/for-mac/issues/388)), preloading Resin OS 1.x will require the older Docker Toolbox ([Mac](https://docs.docker.com/toolbox/toolbox_install_mac/), [Windows](https://docs.docker.com/toolbox/toolbox_install_windows/)) setup with [VirtualBox](https://www.virtualbox.org/) to function properly.
