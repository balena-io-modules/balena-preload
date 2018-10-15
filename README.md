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
- [Command Line Usage](#command-line-usage)
    - [Example](#example)
    - [Additional Options](#additional-options)
    - [Custom Splash Screen](#custom-splash-screen)
- [Module usage](#module-usage)
- [Contributing](#contributing)
- [Known Issues](#known-issues)
    - [Speed Issues For Flasher Images on macOS](#speed-issues-for-flasher-images-on-macos)
    - [Version Compatibility](#version-compatibility)
    - [BTRFS Support](#btrfs-support)

<!-- /MarkdownTOC -->


## Requirements

- [Node](https://nodejs.org)
- [Docker](https://www.docker.com) tested on 1.12.6 and up but 17.04 or up is recommended especially on macOS, [docker-toolbox](https://www.docker.com/products/docker-toolbox) is not supported.
Older versions of balena-preload do support docker-toolbox, see [Version Compatibility](#version-compatibility) below.

## Command Line Usage

```
Usage: balena-preload [options]

Options:

  --app            Application ID (required)
  --img            Disk image (or Edison zip file) to preload into (required)
  --api-token      API token (required, or api-key)
  --api-key        API key (required, or api-token)
  --commit         App commit to be preloaded (default: latest)
  --api-host       API host (default: "https://api.balena-cloud.com", the TLD will also be used for registry2 requests)
  --splash-image   PNG Image for custom splash screen

  --dont-check-arch          Disables check for matching architecture in image and application

  --help, -h       Display balena-preload usage
  --version, -v    Display balena-preload version

Environment variables:

  The following option flags can also be set
  via the corresponding environment variables:

  --app                               APP_ID
  --img                               IMAGE
  --api-token                         API_TOKEN
  --api-key                           API_KEY
  --commit                            COMMIT
  --api-host                          API_HOST
  --splash-image                      SPLASH_IMAGE
  --dont-check-arch                   DONT_CHECK_ARCH

Example:

  balena-preload --app 123456 --api-token "xxxx..." --img /path/to/balena-os.img

```

If using environment variables, this program requires the following options to be set:

  * `IMAGE`: The path to the OS image you downloaded for the `APP_ID` you want to target.
  * `APP_ID`: ID of the App that will be assigned to the device. It can be extracted from the URL in the balena dashboard,
     for instance `https://dashboard.balena-cloud.com/apps/2167` means the `APP_ID` is `2167`.
  * `API_TOKEN`: Authentication token for balena, taken from the [preferences page](https://dashboard.balena-cloud.com/preferences/details).


### Example

**NOTE:** Before running the example below, make sure that you have successfully pushed to the app and
that the `Application commit` is the correct version of the code you intend to preload.

Download an OS image from the balena dashboard and then run:

1) Using option flags for configuration:

```bash
$ balena-preload --app 123456 --api-token "XXX..." --img /path/to/balena.img
```

2) Using environment variables for configuration:

```bash
# Set the environment variables
$ export API_TOKEN=... # copy from dashboard preferences
$ export APP_ID=... # id of your application (you can see it on dashboard URL when you visit your app page)
$ export IMAGE=/path/to/balena.img

# As all required options have been set via environment variables,
# there's no need to pass any options, just run
$ balena-preload
```

The `/path/to/balena.img` file, will now have the latest version of your application preloaded.

### Additional Options

* Alternatively to `API_TOKEN`, you can use an `API_KEY` variable with an API key from a config.json file or the [SDK](https://github.com/balena-io/balena-sdk/blob/master/DOCUMENTATION.md#balena.models.application.getApiKey).
* `API_HOST`: Address of the balena API. If unsure, use `https://api.balena-cloud.com`.
* `SPLASH_IMAGE`: Path to a custom splash image, to copy into the preloaded OS image

### Custom Splash Screen

At this time, the custom splash screen image needs to be a PNG.
For more details on splash images, see:
  - [The Balena.io Notes – What are we working on / Revamping Splash Screens](https://forums.balena.io/t/what-are-we-working-on-the-resin-io-notes/414/7)
  - [Documenting the custom boot splash screen](https://github.com/balena-io/docs/issues/155)
  - [balena-io/balena-plugin-img](https://github.com/balena-io/balena-plugin-img)

## Module usage

Please check bin/balena-preload

## Contributing

### Install from github

 * Clone this repo: `git clone git@github.com:balena-io/balena-preload.git`
 * Change directory: `cd balena-preload`
 * Install dependencies: `npm i`
 * Run balena-preload: `./bin/balena-preload`

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
