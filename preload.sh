#!/bin/bash

set -e
set -o pipefail
set -x

hash curl 2>/dev/null || { echo >&2 "curl is required but it's not installed.  Aborting."; exit 1; }
hash jq 2>/dev/null || { echo >&2 "jq is required but it's not installed.  Aborting."; exit 1; }
hash docker 2>/dev/null || { echo >&2 "docker is required but it's not installed.  Aborting."; exit 1; }
hash losetup 2>/dev/null || { echo >&2 "losetup is required but it's not installed.  Aborting."; exit 1; }
hash partprobe 2>/dev/null || { echo >&2 "partprobe is required but it's not installed.  Aborting."; exit 1; }
hash bash 2>/dev/null || { echo >&2 "bash is required but it's not installed.  Aborting."; exit 1; }
hash btrfs 2>/dev/null || { echo >&2 "btrfs utilities (btrfs-tools) are required but are not installed. Aborting."; exit 1; }

test "$API_TOKEN" -o "$API_KEY" || { echo >&2 "API_TOKEN or API_KEY must be set"; exit 1; }
test "$API_HOST" || { echo >&2 "API_HOST must be set"; exit 1; }
test "$REGISTRY_HOST" || { echo >&2 "REGISTRY_HOST must be set"; exit 1; }
test "$APP_ID" || { echo >&2 "APP_ID must be set"; exit 1; }
test "$IMAGE" || { echo >&2 "IMAGE must be set"; exit 1; }
test -e "$IMAGE" || { echo >&2 "IMAGE file does not exist"; exit 1; }

function cleanup {
        rm $TMP_APPS_JSON || True
        test "$DIND_CID" && docker rm -vf "$DIND_CID"
        test -d "/tmp/docker-$APP_ID" && rm -rf "/tmp/docker-$APP_ID"
        test "`mount | grep \"/mnt/$APP_ID\"`" && umount "/mnt/$APP_ID"
        test -d "/mnt/$APP_ID" && rmdir "/mnt/$APP_ID"
        test "$LOOP_DEV" && losetup -d "$LOOP_DEV"
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

# Get application container size

IMAGE_ID=$(curl -s "$REGISTRY_HOST/v1/repositories/$IMAGE_REPO/tags/latest" | jq -r '.')

CONTAINER_SIZE=$(curl -s "$REGISTRY_HOST/v1/images/$IMAGE_ID/ancestry" |
jq '.[]' |
awk '{print "'$REGISTRY_HOST'/v1/images/" $1 "/json"}' |
xargs -r -n 1 curl -s |
jq -s '[.[].Size] | add | . / 1000000 | floor')

# Size will be increased by 110% of container size
IMG_ADD_SPACE=$(expr $CONTAINER_SIZE \* 110 / 100)

# Add zero bytes to image to be able to resize partitions

dd if=/dev/zero bs=1MB count="$IMG_ADD_SPACE" >> "$IMAGE"

# Resize partition

# Calculate new partition end by getting current partition end and adding the additional spzce.
PART_END=$(sudo parted -m "$IMAGE" p | tail -n 1 | awk -F ':' '{print $3 + '$IMG_ADD_SPACE'}')

# Resize partition table
# Both extended and logical partition must be increased
parted "$IMAGE" resizepart 4 "${PART_END}MB" resizepart 6 "${PART_END}MB"

# mount partition

LOOP_DEV=$(losetup -f)

losetup "$LOOP_DEV" "$IMAGE"
partprobe "$LOOP_DEV"

mkdir -p "/mnt/$APP_ID"
mount "${LOOP_DEV}p6" "/mnt/$APP_ID"

# Resize partition's filesystem
# btrfs resize does not work reliably, fallback to hoping there is enough space
# TODO: find out why btrfs does not allow resizing sometimes
btrfs filesystem resize "+${CONTAINER_SIZE}m" "/mnt/$APP_ID" || true

# write apps.json
# keep only the fields we need from TMP_APPS_JSON
jq '.[0] | [ { appId, commit, imageId, env } ]' $TMP_APPS_JSON > "/mnt/$APP_ID/apps.json"

# pull docker

DIND_CID=$(docker run --privileged -d -v "/tmp/docker-$APP_ID":/var/run -v "/mnt/$APP_ID/rce":/var/lib/docker blueimp/dind:1.6 superd)

echo "Waiting for Docker to start..."
while [ ! -e "/tmp/docker-$APP_ID/docker.sock" ]; do
        sleep 1
done

echo "Pulling image..."
IMAGE_ID=$(jq -r '.[0].imageId' "/mnt/$APP_ID/apps.json")
docker exec "$DIND_CID" docker pull "$IMAGE_ID"

echo "Docker images loaded:"
docker exec "$DIND_CID" docker images --all

echo "Done."
