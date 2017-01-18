#!/bin/bash

set -e
set -o pipefail

IMAGE=${IMAGE:-"/img/resin.img"}
API_HOST=${API_HOST:-"https://api.resin.io"}
REGISTRY_HOST=${REGISTRY_HOST:-"registry.resin.io"}

# Check if credentials have been set
test "$API_TOKEN" -o "$API_KEY" || { echo >&2 "API_TOKEN or API_KEY must be set"; exit 1; }
test "$APP_ID" || { echo >&2 "APP_ID must be set"; exit 1; }
# Check if .img file exists
test -e "$IMAGE" || { echo >&2 "IMAGE file does not exist"; exit 1; }

# Variables
APPS_JSON=
IMAGE_REPO=
IMAGE_ID=
CONTAINER_SIZE=
IMAGE_ADD_SPACE=

# Mountpoints
ROOTFS_MNT="/mnt/$APP_ID-rootfs"
APPFS_MNT="/mnt/$APP_ID"

# Docker vars
DOCKER_TMP="/tmp/docker-$APP_ID"
DOCKER_PID="${DOCKER_TMP}/docker.pid"
DOCKER_SOCK="${DOCKER_TMP}/docker.sock"
DOCKER_DIR=

# Log to stderr to avoid interfering
# with function output
function log() {
    echo >&2 $@
}

function cleanup() {

    log "Cleaning up"

    if [[ -e $DOCKER_PID ]]; then
        log "Waiting for Docker to stop"
        kill $(cat $DOCKER_PID)
        while [[ -e "$DOCKER_PID" ]]; do
            sleep 1
        done
    fi

    if [[ -d $DOCKER_TMP ]]; then
        log "Removing Docker tmp files"
        rm -rfv $DOCKER_TMP || true
    fi

    if [[ $(mount | grep "$ROOTFS_MNT") ]]; then
        log "Unmounting rootfs from $ROOTFS_MNT"
        umount -v $ROOTFS_MNT || true
        test -d $ROOTFS_MNT && rmdir $ROOTFS_MNT
    fi

    if [[ $(mount | grep "$APPFS_MNT") ]]; then
        log "Unmounting application from $APPFS_MNT"
        umount -v $APPFS_MNT || true
        test -d $APPFS_MNT && rmdir $APPFS_MNT
    fi

    sync
    sleep 2
    log "Unmapping loopback interfaces"
    losetup -D || true

}

trap cleanup EXIT

# Transform a version number into a contiguous number for comparison
# Usage: version 2.0.0-beta7
# Output: 002000000
function version() {
    echo "$@" | sed 's/^(\d+(\.\d+)*)/\1/' | awk -F. '{ printf("10#%03d%03d%03d\n", $1,$2,$3); }';
}

# Compare two version numbers
# Usage: version_ge 1.2.0 2.0.0
# Example:
# if version_ge $first_version $second_version; then
#   echo "$first_version >= $second_version !"
# fi
function version_ge() {
    [[ $(version $1) -ge $(version $2) ]]
}

# Fetch application metadata
# NOTE: Depends on ($API_TOKEN | $API_HOST & $API_KEY),
# $APP_ID, and $REGISTRY_HOST being set
function get_app_data() {
    local response=
    if test "$API_TOKEN"; then
        log "Using API_TOKEN"
        response=$(curl -sH "Authorization: Bearer $API_TOKEN" "$API_HOST/v2/application($APP_ID)?\$expand=environment_variable")
    elif test "$API_KEY"; then
        log "Using API_KEY"
        response=$(curl "$API_HOST/v2/application($APP_ID)?\$expand=environment_variable&apikey=$API_KEY")
    fi
    echo $response | jq --arg registryHost "$REGISTRY_HOST" '.d[0] |
        (.app_name) as $repoName |
        ($repoName + "/" + .commit | ascii_downcase) as $imageRepo |
        ($registryHost + "/" + $imageRepo | ascii_downcase) as $imageId |
        ((.environment_variable // []) | map(select((.name|startswith("RESIN_"))==false)) | map({(.name): .value}) | add) as $env |
        ((.environment_variable // []) | map(select(.name|startswith("RESIN_"))) | map({(.name): .value}) | add) as $config
        [ { appId: .id, commit, imageRepo: $imageRepo, imageId: $imageId, env: $env, config: $config } ]'
}

# Fetch container metadata
function get_container_size() {
    echo $(curl -s "$REGISTRY_HOST/v1/images/$IMAGE_ID/ancestry" | \
        jq '.[]' | awk '{print "'$REGISTRY_HOST'/v1/images/" $1 "/json"}' | \
        xargs -r -n 1 curl -I -s | \
        grep 'X-Docker-Size' | \
        awk '{s+=$2} END {print int(s / 1000000)}')
}

# Usage: map_loop <image> <part_no>
function map_loop() {
    # Find the next free /dev/loop
    local LOOPDEVICE=$(losetup -f)
    # Get partition offset & size
    local PART_START=$(get_partition_start $2 B)
    local PART_END=$(get_partition_end $2 B)
    local PART_SIZE=$(( $PART_END - $PART_START + 1 ))
    # Map image partition to device
    log "Mapping $IMAGE $PART_START:$PART_SIZE to $LOOPDEVICE"
    losetup $LOOPDEVICE $1 --offset $PART_START --sizelimit $PART_SIZE >&2
    echo $LOOPDEVICE
}

# Usage: unmap_loop <loopdevice>
function unmap_loop() {
    log "Unmapping" $1
    losetup -d $1
}

# Mount the image's rootfs to $ROOTFS_MNT
# Usage: mount_rootfs <device>
function mount_rootfs() {
    log
    log "Mounting rootfs from $1 to" $ROOTFS_MNT
    # Create the mount path, then sync & sleep
    # to ensure it exists before mounting
    mkdir -p $ROOTFS_MNT
    sync
    sleep 2
    # Mount the rootfs from partition 2
    mount -o loop,ro $1 $ROOTFS_MNT
}

function unmount_rootfs() {
    log "Unmounting rootfs from" $ROOTFS_MNT
    umount -v $ROOTFS_MNT || true
    test -d $ROOTFS_MNT && rmdir $ROOTFS_MNT
}

# Get the Resin OS version info by mounting the root partition
# and setting the variables from `/etc/os-release`
# Usage: get_resin_os_version <mount_path>
# Available variables:
#
# ID="resin-os"
# NAME="Resin OS"
# VERSION="2.0.0-beta.7"
# VERSION_ID="2.0-beta.7"
# PRETTY_NAME="Resin OS 2.0.0-beta.7"
# RESIN_BOARD_REV=82eeb8b
# META_RESIN_REV=0870520
# SLUG=raspberrypi3
# MACHINE=raspberrypi3
function get_resin_os_version() {

    local LOOPDEVICE=$(map_loop $IMAGE 2)
    mount_rootfs $LOOPDEVICE

    log
    local OS_RELEASE="${1}/etc/os-release"
    log "Sourcing release info from" $OS_RELEASE
    source $OS_RELEASE

    log "Detected" $PRETTY_NAME

    log
    log "id:" $ID
    log "name:" $NAME
    log "version:" $VERSION
    log "version_id:" $VERSION_ID
    log "pretty_name:" $PRETTY_NAME
    log "resin_board_rev:" $RESIN_BOARD_REV
    log "meta_resin_rev:" $META_RESIN_REV
    log "slug:" $SLUG
    log "machine:" $MACHINE
    log

    unmount_rootfs
    unmap_loop $LOOPDEVICE

}

# Usage: expand_image <image_path>
function expand_image() {
    # Size will be increased by 110% of container size
    IMAGE_ADD_SPACE=$(($CONTAINER_SIZE / 100 + 300))
    log "Expanding image by" $IMAGE_ADD_SPACE "MB"
    # Add zero bytes to image to be able to resize partitions
    dd if=/dev/zero bs=1M count="$IMAGE_ADD_SPACE" >> "$IMAGE"
}

# Get the start offset (in bytes) of a partition by partition number
# Usage: get_partition_start <part_no> <unit>
function get_partition_start() {
    # We need to skip the first two lines of `parted` output
    local LINENO=$(($1 + 2))
    # Extract value & strip the unit
    local PATTERN="s/[^:]:\([^${2}]*\).*/\1/"
    parted -s -m $IMAGE unit $2 p | sed -n "${LINENO}p" | sed $PATTERN
}

# Get the end offset (in bytes) of a partition by partition number
# Usage: get_partition_end <part_no> <unit>
function get_partition_end() {
    # We need to skip the first two lines of `parted` output
    local LINENO=$(($1 + 2))
    # Extract value & strip the unit
    local PATTERN="s/[^:]:[^${2}]*${2}:\([^${2}]*\).*/\1/"
    parted -s -m $IMAGE unit $2 p | sed -n "${LINENO}p" | sed $PATTERN
}

# Resizes partition 4 & 6 by <add_space> (in MB)
# Usage: expand_partitions <add_space>
function expand_partitions() {
    local PART_END=$(get_partition_end 6 MB)
    local NEW_PART_END=$(($PART_END + $1))
    log "Expanding extended partition 4 by" $1 "MB"
    log "Expanding logical partition 6 by" $1 "MB"
    parted -s "$IMAGE" resizepart 4 "${NEW_PART_END}MB" resizepart 6 "${NEW_PART_END}MB"
}

# Resize ext4 filesystem
function expand_ext4() {
    local LOOPDEVICE=$(map_loop $IMAGE 6)
    log "Using" $LOOPDEVICE

    # For ext4, we'll have to keep it unmounted to resize
    log "Resizing filesystem"
    e2fsck -f $LOOPDEVICE && resize2fs -f $LOOPDEVICE
    mount -t ext4 -o rw $LOOPDEVICE $APPFS_MNT
}

# Resize BTRFS filesystem
function expand_btrfs() {
    log
    # For btrfs we'll need to mount the fs, and setup the loop device manually,
    local LOOPDEVICE=$(map_loop $IMAGE 6)
    log "Using" $LOOPDEVICE

    log "Mounting application fs to" $APPFS_MNT
    mount -t btrfs -o nospace_cache,rw $LOOPDEVICE $APPFS_MNT

    log "Resizing filesystem"
    btrfs filesystem resize max $APPFS_MNT
}

# Write apps.json to file $1
# Usage: write_apps_json <path>
function write_apps_json() {
    echo $APPS_JSON | jq '.[0] | [ { appId, commit, imageId, env, config } ]' > $1
}

# Start the docker daemon
# Usage: start_docker_daemon <filesystem_type>
function start_docker_daemon() {
    mkdir -p $DOCKER_TMP

    # If this preload script was ran before implementing the rce/docker fix,
    # make sure you cleanup
    if [[ -d "${APPFS_MNT}/docker" ]]; then
        log "Removing" "${APPFS_MNT}/rce"
        rm -rfv "${APPFS_MNT}/rce"
        DOCKER_DIR="${APPFS_MNT}/docker"
    else
        DOCKER_DIR="${APPFS_MNT}/rce"
    fi

    docker daemon -s $1 -g "$DOCKER_DIR" -p "$DOCKER_PID" -H "unix://$DOCKER_SOCK" &

    log "Waiting for Docker to start..."
    while [ ! -e "$DOCKER_SOCK" ]; do
        sleep 1
    done
    log "Docker started"
}

# Fetch & process app / image / container data, set $APPS_JSON,
# $IMAGE_REPO, $IMAGE_ID, and $CONTAINER_SIZE
log "Fetching application data"
log "Using API host" $API_HOST
log "Using Registry host" $REGISTRY_HOST
APPS_JSON=$(get_app_data)
IMAGE_REPO=$(echo $APPS_JSON | jq -r '.[0].imageRepo')

log "Fetching image data" $IMAGE_REPO
IMAGE_ID=$(curl -s "$REGISTRY_HOST/v1/repositories/$IMAGE_REPO/tags/latest" | jq -r '.')
log "Image ID:" $IMAGE_ID

log "Fetching container data"
CONTAINER_SIZE=$(get_container_size)
log "Container size:" $CONTAINER_SIZE "MB"

get_resin_os_version $ROOTFS_MNT

parted -s $IMAGE unit MB p

# Resize partition
expand_image $IMAGE
expand_partitions $IMAGE_ADD_SPACE

parted -s $IMAGE unit MB p

log "Creating mountpoint" $APPFS_MNT
# Create the mount path, then sync & sleep
# to ensure it exists before mounting
mkdir -p $APPFS_MNT
sync
sleep 2

# Check for Resin OS version,
# and switch from BTRFS to EXT4 for 2.0.0+,
# then expand & mount the application filesystem
log "Expanding filesystem"
if version_ge $VERSION "2.0.0"; then
    log "Using EXTFS"
    expand_ext4
    start_docker_daemon aufs
else
    log "Using BTRFS"
    expand_btrfs
    start_docker_daemon btrfs
fi

# write apps.json
# keep only the fields we need from APPS_JSON
write_apps_json "${APPFS_MNT}/apps.json"

log "Pulling image..."
IMAGE_ID=$(jq -r '.[0].imageId' "${APPFS_MNT}/apps.json")
docker -H "unix://$DOCKER_SOCK" pull "$IMAGE_ID"

log "Docker images loaded:"
docker -H "unix://$DOCKER_SOCK" images --all

log "Done."
