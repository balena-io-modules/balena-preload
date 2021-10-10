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
- [Known Issues](#known-issues)
    - [Speed Issues For Flasher Images on macOS](#speed-issues-for-flasher-images-on-macos)
    - [Version Compatibility](#version-compatibility)
    - [BTRFS Support](#btrfs-support)

<!-- /MarkdownTOC -->

## Requirements

- [Node](https://nodejs.org)
- [Docker](https://www.docker.com) tested on 1.12.6 and up but 17.04 or up is recommended especially on macOS, [docker-toolbox](https://www.docker.com/products/docker-toolbox) is not supported.
Older versions of balena-preload do support docker-toolbox, see [Version Compatibility](#version-compatibility) below.

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
