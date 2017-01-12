#!/bin/bash

set -e
set -o pipefail

test "$API_TOKEN" -o "$API_KEY" || { echo >&2 "API_TOKEN or API_KEY must be set"; exit 1; }
test "$APP_ID" || { echo >&2 "APP_ID must be set"; exit 1; }

IMAGE=${IMAGE:-"/img/resin.img"}
test -e "$IMAGE" || { echo >&2 "IMAGE file does not exist"; exit 1; }

API_HOST=${API_HOST:-"https://api.resin.io"}
REGISTRY_HOST=${REGISTRY_HOST:-"registry.resin.io"}

function cleanup {
  test -e $TMP_APPS_JSON && rm $TMP_APPS_JSON || true
  test "$DOCKER_PID" && kill $(cat $DOCKER_PID)
  
  echo "Waiting for Docker to stop..."
  while [ -e "$DOCKER_PID" ]; do
    sleep 1
  done
  
  test -d "/tmp/docker-$APP_ID" && rm -rf "/tmp/docker-$APP_ID"
  test "`mount | grep \"/mnt/$APP_ID\"`" && umount "/mnt/$APP_ID" || true
  test -d "/mnt/$APP_ID" && rmdir "/mnt/$APP_ID"
  
  # Detach all /dev/loop interfaces
  losetup -D
}

trap cleanup EXIT

function version() {
  echo "$@" | sed 's/^(\d+(\.\d+)*)/\1/' | awk -F. '{ printf("%03d%03d%03d\n", $1,$2,$3); }';
}

# Compare two version numbers
# Usage:
# if version_ge $first_version $second_version; then
#   echo "$first_version >= $second_version !"
# fi
function version_ge() {
  [[ $(version $1) > $(version $2) || $(version $1) = $(version $2) ]]
}

# Get the start offset (in bytes) of a partition by partition number
# Usage: get_partition_start <part_no> <unit>
function get_partition_start() {
  # We need to skip the first two lines of `parted` output
  local LINENO=$(expr $1 + 2)
  # Extract value & strip the unit
  local PATTERN="s/[^:]:\([^${2}]*\).*/\1/"
  parted -s -m $IMAGE unit $2 p | sed -n "${LINENO}p" | sed $PATTERN
}

# Get the end offset (in bytes) of a partition by partition number
# Usage: get_partition_end <part_no> <unit>
function get_partition_end() {
  # We need to skip the first two lines of `parted` output
  local LINENO=$(expr $1 + 2)
  # Extract value & strip the unit
  local PATTERN="s/[^:]:[^${2}]*${2}:\([^${2}]*\).*/\1/"
  parted -s -m $IMAGE unit $2 p | sed -n "${LINENO}p" | sed $PATTERN
}

# Resizes partition 4 & 6 by the offset of <part_no> by <add_space> (in MB)
# Usage: resize_partition <part_no> <add_space>
function resize_partition() {
  local PART_END=$(get_partition_end $1 MB)
  local NEW_PART_END=$(expr $PART_END + $2)
  echo "Resize partition $1 from offset ${PART_END}MB to ${NEW_PART_END}MB"
  # Resize partition table
  # Both extended and logical partition must be increased
  parted -s "$IMAGE" resizepart 4 "${NEW_PART_END}MB" resizepart 6 "${NEW_PART_END}MB"
}

# Expand the image
# NOTE: Depends on get_app_data() being called first
function expand_image() {
  CONTAINER_SIZE=$(curl -s "$REGISTRY_HOST/v1/images/$IMAGE_ID/ancestry" | \
  jq '.[]' | awk '{print "'$REGISTRY_HOST'/v1/images/" $1 "/json"}' | \
  xargs -r -n 1 curl -I -s | \
  grep 'X-Docker-Size' | \
  awk '{s+=$2} END {print int(s / 1000000)}')
  echo "Container size:" $CONTAINER_SIZE "MB"
  # Size will be increased by 110% of container size
  IMG_ADD_SPACE=$(expr $CONTAINER_SIZE / 100 + 300)
  echo "Expanding image by" $IMG_ADD_SPACE "MB"
  # Add zero bytes to image to be able to resize partitions
  dd if=/dev/zero bs=1M count="$IMG_ADD_SPACE" >> "$IMAGE"
}

# Get the resinOS version by mounting the root partition
# and read `/etc/os-release` to set the variables in it
# Example:
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
  local ROOT_PART_START=$(get_partition_start 2 B)
  local ROOTMNT="/mnt/${APP_ID}-root"
  local OS_RELEASE="${ROOTMNT}/etc/os-release"
  echo "rootfs partition start: $ROOT_PART_START"
  echo "mounting rootfs to: $ROOTMNT"
  mkdir -p $ROOTMNT
  # Make sure directory exists before mounting to it
  sync
  sleep 2
  echo "mount -o loop,ro,offset=${ROOT_PART_START} $IMAGE $ROOTMNT"
  mount -o "loop,ro,offset=${ROOT_PART_START}" "$IMAGE" "$ROOTMNT"
  local DEVICE=$(losetup --partscan --find --show $IMAGE)
  echo "blockdevice" $DEVICE
  eval $(cat $OS_RELEASE)
  # Clean up
  test "`mount | grep \"$ROOTMNT\"`" && umount $ROOTMNT || true
  test -d $ROOTMNT && rmdir $ROOTMNT
  echo "Detaching $DEVICE"
  losetup -D
}

# Get app data and write to temporary file
function get_app_data() {
  ( if test "$API_TOKEN"; then
          curl -sH "Authorization: Bearer $API_TOKEN" "$API_HOST/ewa/application($APP_ID)?\$expand=environment_variable"
  elif test "$API_KEY"; then
          curl "$API_HOST/ewa/application($APP_ID)?\$expand=environment_variable&apikey=$API_KEY"
  fi ) | jq --arg registryHost "$REGISTRY_HOST" '.d[0] |
          (.git_repository | split("/") | .[1] | rtrimstr(".git")) as $repoName |
          ($repoName + "/" + .commit) as $imageRepo |
          ($registryHost + "/" + $imageRepo) as $imageId |
    ((.environment_variable // []) | map({(.name): .value}) | add) as $env |
          [ { appId: .id, commit, imageRepo: $imageRepo, imageId: $imageId, env: $env } ]' > "$TMP_APPS_JSON"

  IMAGE_REPO=$(jq -r '.[0].imageRepo' "$TMP_APPS_JSON")
  echo "Loading the following image: " $IMAGE_REPO
  IMAGE_ID=$(curl -s "$REGISTRY_HOST/v1/repositories/$IMAGE_REPO/tags/latest" | jq -r '.')
  echo "Image id: " $IMAGE_ID
}

TMP_APPS_JSON=$(mktemp)

get_resin_os_version
echo "Detected $PRETTY_NAME"

echo
echo "  id: $ID"
echo "  name: $NAME"
echo "  version: $VERSION"
echo "  version_id: $VERSION_ID"
echo "  pretty_name: $PRETTY_NAME"
echo "  resin_board_rev: $RESIN_BOARD_REV"
echo "  meta_resin_rev: $META_RESIN_REV"
echo "  slug: $SLUG"
echo "  machine: $MACHINE"
echo

# Fetch app & image data
get_app_data
# Expand the image
expand_image
# Resize extended & logical partition
resize_partition 6 $IMG_ADD_SPACE

# Make sure directory exists before mounting to it
mkdir -p "/mnt/$APP_ID"
sync
sleep 2

# Check for Resin OS version, and switch from BTRFS to AUFS for 2.0.0+
if version_ge $VERSION "2.0.0"; then
  echo "Using EXTFS"
  # Mount ext4 and get it's loopback blockdevice
  PART_START=$(get_partition_start 6 B)
  mount -t ext4 -o "loop,rw,offset=${PART_START}" "$IMAGE" "/mnt/$APP_ID"
  LOOP=$(losetup --partscan --find --show $IMAGE)
  # Check & resize filesystem
  echo "Resizing filesystem on" $LOOP
  e2fsck -f "${LOOP}p6" && resize2fs -f "${LOOP}p6"
  # Clean up
  echo "Detaching $LOOP"
  losetup -D
else
  echo "Using BTRFS"
  # Get partion offset
  PART_START=$(get_partition_start 6 B)
  mount -t btrfs -o "nospace_cache,loop,rw,offset=${PART_START}" "$IMAGE" "/mnt/$APP_ID"
  # Resize partition's filesystem
  btrfs filesystem resize max "/mnt/$APP_ID"
fi

# write apps.json
# keep only the fields we need from TMP_APPS_JSON
jq '.[0] | [ { appId, commit, imageId, env } ]' $TMP_APPS_JSON > "/mnt/$APP_ID/apps.json"

mkdir -p "/tmp/docker-$APP_ID"
DOCKER_PID="/tmp/docker-$APP_ID/docker.pid"
DOCKER_SOCK="/tmp/docker-$APP_ID/docker.sock"

# start docker daemon that uses rce/docker partition for storage
if [ -d "/mnt/$APP_ID/docker" ]; then
  # If this preload script was ran before implementing the rce/docker fix,
  # make sure you cleanup
  rm -rf /mnt/$APP_ID/rce

  DOCKER_DIR=/mnt/$APP_ID/docker
else
  DOCKER_DIR=/mnt/$APP_ID/rce
fi
docker daemon -s btrfs -g "$DOCKER_DIR" -p "$DOCKER_PID" -H "unix://$DOCKER_SOCK" &

echo "Waiting for Docker to start..."
while [ ! -e "$DOCKER_SOCK" ]; do
        sleep 1
done

echo "Pulling image..."
IMAGE_ID=$(jq -r '.[0].imageId' "/mnt/$APP_ID/apps.json")
docker -H "unix://$DOCKER_SOCK" pull "$IMAGE_ID"

echo "Docker images loaded:"
docker -H "unix://$DOCKER_SOCK" images --all

echo "Done."
