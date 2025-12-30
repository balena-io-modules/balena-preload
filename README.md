# balena-preload
[![npm](https://img.shields.io/npm/v/balena-preload.svg?style=flat-square)](https://npmjs.com/package/balena-preload)
[![npm license](https://img.shields.io/npm/l/balena-preload.svg?style=flat-square)](https://npmjs.com/package/balena-preload)
[![npm downloads](https://img.shields.io/npm/dm/balena-preload.svg?style=flat-square)](https://npmjs.com/package/balena-preload)

Script for preloading balena OS images (`.img`) with a user application container.

Using this will allow images with supervisor version above 1.0.0 to run the user application without connectivity, and without the need to download the container.

## Warning

In order to preload images that use the overlay2 Docker storage driver (like
nvidia jetson tx2 for example), you need to load the `overlay` Linux module:

```sh
sudo modprobe overlay
```

For other images you will need to have the `aufs` module loaded.


## Deprecation

The standalone mode described below (balena-preload) is now deprecated.
It will be removed in a future release.
You should use [balena-cli](https://www.npmjs.com/package/balena-cli) instead.

Install [balena-cli](https://www.npmjs.com/package/balena-cli) and run
`balena help preload`.


## Install via [npm](https://npmjs.com)

```sh
$ npm install --global balena-preload
```

<!-- MarkdownTOC -->

- [Requirements](#requirements)
- [How apps.json is Generated](#how-appsjson-is-generated)
- [Known Issues](#known-issues)
    - [Speed Issues For Flasher Images on macOS](#speed-issues-for-flasher-images-on-macos)
    - [Version Compatibility](#version-compatibility)
    - [BTRFS Support](#btrfs-support)

<!-- /MarkdownTOC -->

## Requirements

- [Node](https://nodejs.org)
- [Docker](https://www.docker.com) tested on 1.12.6 and up but 17.04 or up is recommended especially on macOS, [docker-toolbox](https://www.docker.com/products/docker-toolbox) is not supported.
Older versions of balena-preload do support docker-toolbox, see [Version Compatibility](#version-compatibility) below.

## How apps.json is Generated

The `apps.json` file is a critical component of the preloading process. It tells the balenaOS supervisor which application containers to run on first boot, enabling devices to operate without initial cloud connectivity.

### Generation Process

1. **Fetch Device State**: The TypeScript code in `preload.ts` fetches the target device state from the Balena API using the `_getState()` method. This state contains information about which application release and services should run on the device.

2. **Transform to Supervisor Format**: The `_getAppData()` method transforms the API state into the format expected by the supervisor. The format varies by supervisor version:
   
   - **Supervisor < 7.0.0 (Target State v1)**: Returns an array of app objects, each with `appId`, `env` (environment variables), `imageId`, and other metadata. This is for single-container applications.
   
   - **Supervisor >= 7.0.0 (Target State v2/v3)**: Returns an object with `apps` and `pinDevice` properties, supporting multicontainer applications with multiple services per app. The `pinDevice` option can pin the device to a specific release.

3. **Write to Disk Image**: The transformed app data is passed to the Python script (`preload.py`) running in a Docker container. The Python script:
   - Mounts the balenaOS image's data partition
   - Writes the app data as JSON to `/data/apps.json` using the `write_apps_json()` function
   - Ensures the file is formatted with proper indentation and sorted keys

4. **Supervisor Reads on Boot**: When the device boots for the first time, the supervisor reads `/data/apps.json` to know which containers to start, eliminating the need to fetch this information from the cloud.

### Example Structure

For supervisor >= 7.0.0, the `apps.json` might look like:

```json
{
  "apps": {
    "1234567": {
      "releaseId": 987654,
      "services": {
        "main": {
          "image": "registry2.balena-cloud.com/v2/abc123...",
          "environment": {
            "VAR1": "value1"
          }
        }
      }
    }
  },
  "pinDevice": false
}
```

For supervisor < 7.0.0, it's a simpler array format:

```json
[
  {
    "appId": "1234567",
    "imageId": "registry2.balena-cloud.com/v2/abc123...",
    "env": {
      "VAR1": "value1"
    }
  }
]
```

### Issues

 If you encounter any problem, you can [open an issue](https://github.com/balena-io/balena-preload/issues)

## Known Issues

### Speed Issues For Flasher Images on macOS

Docker on macOS has [some speed issues with volumes](https://github.com/docker/for-mac/issues/77).
This makes this script slow, especially with Flasher Images.

### Version Compatibility

This version will only work for balena OS versions 1.2 and later.
For versions earlier than 1.2 you will need to checkout commit `5d6d4607bffc98acdf649ce5328e2079dfb9c3d9` of this repo and then follow the steps below. 

### BTRFS Support

Since Docker for Mac removed support for the BTRFS storage driver (see [docker/for-mac/issues/388](https://github.com/docker/for-mac/issues/388)), preloading images prior to balena OS 2.0 will require the older [Docker toolbox](https://docs.docker.com/toolbox/toolbox_install_mac/) setup with [VirtualBox](https://www.virtualbox.org/) to function properly.
