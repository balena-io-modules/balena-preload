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
        rm $TMP_APPS_JSON || true
	test "$DOCKER_PID" && kill $(cat $DOCKER_PID)
	echo "Waiting for Docker to stop..."
	while [ -e "$DOCKER_PID" ]; do
		sleep 1
	done
        test -d "/tmp/docker-$APP_ID" && rm -rf "/tmp/docker-$APP_ID"
        test "`mount | grep \"/mnt/$APP_ID\"`" && umount "/mnt/$APP_ID"
        test -d "/mnt/$APP_ID" && rmdir "/mnt/$APP_ID"
}

trap cleanup EXIT

# Get app data and write to temporary file

TMP_APPS_JSON=$(mktemp)

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

# Get application container size

IMAGE_ID=$(curl -s "$REGISTRY_HOST/v1/repositories/$IMAGE_REPO/tags/latest" | jq -r '.')

CONTAINER_SIZE=$(curl -s "$REGISTRY_HOST/v1/images/$IMAGE_ID/ancestry" | \
jq '.[]' | awk '{print "'$REGISTRY_HOST'/v1/images/" $1 "/json"}' | \
xargs -r -n 1 curl -I -s | \
grep 'X-Docker-Size' | \
awk '{s+=$2} END {print int(s / 1000000)}')
echo "container size: " $CONTAINER_SIZE "MB"

# Size will be increased by 110% of container size
IMG_ADD_SPACE=$(expr $CONTAINER_SIZE / 100 + 300)

# Add zero bytes to image to be able to resize partitions

dd if=/dev/zero bs=1M count="$IMG_ADD_SPACE" >> "$IMAGE"

# Resize partition

# Calculate new partition end by getting current partition end and adding the additional spzce.
PART_END=$(parted -s -m "$IMAGE" p | tail -n 1 | awk -F ':' '{print $3 + '$IMG_ADD_SPACE'}')

# Resize partition table
# Both extended and logical partition must be increased
parted -s "$IMAGE" resizepart 4 "${PART_END}MB" resizepart 6 "${PART_END}MB"

# mount partition

PART_START=$(parted -s -m "$IMAGE" unit B p | tail -n 1 | sed 's/[^:]:\([^B]*\).*/\1/')

mkdir -p "/mnt/$APP_ID"
# make sure directory exists before mounting to it
sync
sleep 2
mount -t btrfs -o "nospace_cache,loop,rw,offset=${PART_START}" "$IMAGE" "/mnt/$APP_ID"

# Resize partition's filesystem
btrfs filesystem resize max "/mnt/$APP_ID"

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
