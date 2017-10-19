#!/usr/bin/python3 -u
import json
import os

from contextlib import contextmanager
from functools import partial
from logging import getLogger, INFO, StreamHandler
from math import ceil, floor
from re import sub
from sh import (
    btrfs,
    dd,
    docker,
    dockerd,
    e2fsck,
    losetup,
    mount,
    parted,
    resize2fs,
    sfdisk,
    umount,
    ErrorReturnCode,
)
from shutil import copyfile, rmtree
from sys import exit
from tempfile import mkdtemp, NamedTemporaryFile

os.environ["LANG"] = "C"

SECTOR_SIZE = 512

PARTITIONS = json.loads(os.environ["PARTITIONS"])

SPLASH_IMAGE_FROM = "/img/resin-logo.png"
SPLASH_IMAGE_TO = "/splash/resin-logo.png"

DOCKER_HOST = "tcp://0.0.0.0:{}".format(os.environ.get("DOCKER_PORT") or 8000)

log = getLogger(__name__)
log.setLevel(INFO)
log.addHandler(StreamHandler())


def human_size(size, precision=2):
    suffixes = ['', 'Ki', 'Mi', 'Gi', 'Ti']
    idx = 0
    while idx < 4 and size >= 1024:
        idx += 1
        size /= 1024
    result = "{:.{}f}".format(size, precision).rstrip("0").rstrip(".")
    return "{} {}B".format(result, suffixes[idx])


def get_offsets_and_sizes(image, unit="B"):
    result = []
    output = parted("-s", "-m", image, "unit", unit, "p").stdout.decode("utf8")
    lines = output.strip().split("\n")
    for line in lines:
        if line[0].isdigit():
            data = line.split(":")
            offset = int(data[1][:-1])
            size = int(data[3][:-1])
            result.append((offset, size))
    return result


def get_partition(name, image=None):
    partition = PARTITIONS[name].copy()
    # override disk image (needed for flashed type devices)
    if image is not None:
        partition["image"] = image
    return partition


def get_offset_and_size(part):
    if part["number"] == 0:
        # partition image: no need to read the partition table
        return 0, file_size(part["image"])
    else:
        # disk image
        return get_offsets_and_sizes(part["image"])[part["number"] - 1]


def mount_partition(partition_name, extra_options, image):
    part = get_partition(partition_name, image)
    offset, size = get_offset_and_size(part)
    mountpoint = mkdtemp()
    options = "offset={},sizelimit={}".format(offset, size)
    if extra_options:
        options += "," + extra_options
    mount("-o", options, part["image"], mountpoint)
    return mountpoint


@contextmanager
def mount_context_manager(partition_name, extra_options="", image=None):
    mountpoint = mount_partition(partition_name, extra_options, image)
    yield mountpoint
    umount(mountpoint)
    os.rmdir(mountpoint)


def losetup_partition(partition_name, image=None):
    part = get_partition(partition_name, image)
    offset, size = get_offset_and_size(part)
    return losetup(
        "-o",
        offset,
        "--sizelimit",
        size,
        "-P",
        "--show",
        "-f",
        part["image"],
    ).stdout.decode("utf8").strip()


@contextmanager
def losetup_context_manager(partition_name, image=None):
    device = losetup_partition(partition_name, image=image)
    yield device
    losetup("-d", device)


def expand_file(path, additional_space):
    with open(path, "a") as f:
        size = f.tell()
        f.truncate(size + additional_space)


def expand_ext4(partition_name, image=None):
    # Resize ext4 filesystem
    error = False
    with losetup_context_manager(partition_name, image=image) as loop_device:
        log.info("Using {}".format(loop_device))
        log.info("Resizing filesystem")
        try:
            status = e2fsck("-p", "-f", loop_device, _ok_code=[0, 1, 2])
            status = status.exit_code
            if status == 0:
                log.info("e2fsck: File system OK")
            else:
                log.warning("e2fsck: File system errors corrected")
        except ErrorReturnCode:
            log.error("e2fsck: File system errors could not be corrected")
            error = True
        resize2fs("-f", loop_device)
    if error:
        exit(1)


def expand_btrfs(mountpoint):
    btrfs("filesystem", "resize", "max", mountpoint)


def fix_rce_docker(mountpoint):
    """
    Removes the /rce folder if a /docker folder exists.
    Returns "<mountpoint>/docker" if this folder exists, "<mountpoint>/rce"
    otherwise.
    """
    _docker_dir = mountpoint + "/docker"
    _rce_dir = mountpoint + "/rce"
    if os.path.isdir(_docker_dir):
        if os.path.isdir(_rce_dir):
            rmtree(_rce_dir)
        return _docker_dir
    else:
        return _rce_dir


def start_docker_daemon(storage_driver, docker_dir):
    """Starts the docker daemon and waits for it to be ready."""
    running_dockerd = dockerd(
        storage_driver=storage_driver,
        data_root=docker_dir,
        host=DOCKER_HOST,
        _bg=True,
    )
    log.info("Waiting for Docker to start...")
    ok = False
    while not ok:
        # dockerd should not exit, if it does, we'll throw an exception.
        if running_dockerd.process.exit_code is not None:
            # There is no reason for dockerd to exit with a 0 status now.
            assert running_dockerd.process.exit_code != 0
            # This will raise an sh.ErrorReturnCode_X exception.
            running_dockerd.wait()
        # Check that we can connect to dockerd.
        output = docker("--host", DOCKER_HOST, "version", _ok_code=[0, 1])
        ok = output.exit_code == 0
    log.info("Docker started")
    return running_dockerd


def read_file(name):
    with open(name, "rb") as f:
        return f.read()


def write_file(name, content):
    with open(name, "wb") as f:
        f.write(content)


@contextmanager
def docker_context_manager(storage_driver, mountpoint):
    docker_dir = fix_rce_docker(mountpoint)
    # If we don't remove <part6>/<docker|rce>/network/files/local-kv.db and the
    # preload container was started with bridged networking, the following
    # dockerd is not reachable from the host.
    local_kv_db_path = "{}/network/files/local-kv.db".format(docker_dir)
    kv_file_existed = (
        os.path.exists(local_kv_db_path) and os.path.isfile(local_kv_db_path)
    )
    if kv_file_existed:
        local_kv_db_content = read_file(local_kv_db_path)
        os.remove(local_kv_db_path)
    running_dockerd = start_docker_daemon(storage_driver, docker_dir)
    yield
    running_dockerd.terminate()
    running_dockerd.wait()
    if kv_file_existed:
        write_file(local_kv_db_path, local_kv_db_content)


def write_apps_json(data, output):
    """Writes data dict to output as json"""
    with open(output, "w") as f:
        json.dump([data], f, indent=4, sort_keys=True)


def replace_splash_image(image=None):
    """
    Replaces the resin-logo.png used on boot splash to allow a more branded
    experience.
    """
    if os.path.isfile(SPLASH_IMAGE_FROM):
        with mount_context_manager("boot", image=image) as mpoint:
            path = mpoint + SPLASH_IMAGE_TO
            if os.path.isdir(os.path.dirname(path)):
                log.info("Replacing splash image")
                copyfile(SPLASH_IMAGE_FROM, path)
            else:
                log.info(
                    "No splash folder on the boot partition, the splash image "
                    "won't be inserted."
                )
    else:
        log.info("Leaving splash image alone")


def resize_fs_copy_splash_image_and_pull(app_data, image=None):
    driver = get_docker_storage_driver(image)
    extra_options = ""
    if driver != "btrfs":
        # For ext4, we'll have to keep it unmounted to resize
        log.info("Expanding ext filesystem")
        expand_ext4("data", image=image)
    else:
        extra_options = "nospace_cache,rw"
    with mount_context_manager("data", extra_options, image=image) as mpoint:
        if driver == "btrfs":
            # For btrfs we need to mount the fs for resizing.
            log.info("Expanding btrfs filesystem")
            expand_btrfs(mpoint)
        with docker_context_manager(driver, mpoint):
            write_apps_json(app_data, mpoint + "/apps.json")
            # Signal that Docker is ready.
            print(json.dumps({}))
            # Wait for the js to finish its job.
            input()


def round_to_sector_size(size, sector_size=SECTOR_SIZE):
    sectors = size / sector_size
    if not sectors.is_integer():
        sectors = floor(sectors) + 1
    return int(sectors * sector_size)


def file_size(path):
    with open(path, "a") as f:
        return f.tell()


def ddd(**kwargs):
    # dd helper
    return dd(*("{}={}".format(k.lstrip("_"), v) for k, v in kwargs.items()))


def resize_rootfs_get_sfdisk_script(image, additional_sectors):
    """
    Helper for resize_rootfs: it gets the image sfdisk script, updates it
    by increasing the size of the 2nd partition and moving all partitions after
    it, and returns the resulting sfdisk script.
    """
    # Extract the image layout.
    layout = sfdisk(d=image).stdout.decode("utf8").strip()

    def add_size(match):
        # Helper for updating offset / size in a sfdisk script file line.
        groups = list(match.groups())
        groups[1] = str(int(groups[1]) + additional_sectors)
        return "".join(groups)

    lines = layout.split("\n")
    # Update 2nd partition size in the new layout.
    lines[6] = sub("(.*size=\s*)(\d+)(,.*)", add_size, lines[6])
    # Update the offsets of partitions 3+.
    for i in range(7, len(lines)):
        lines[i] = sub("(.*start=\s*)(\d+)(,.*)", add_size, lines[i])
    return "\n".join(lines)


def resize_rootfs(additional_space):
    log.info("Resizing the 2nd partition of the image.")
    part = get_partition("root")
    image = part["image"]
    size = file_size(image) + additional_space
    log.info("New disk image size: {}.".format(human_size(size)))
    additional_sectors = additional_space // SECTOR_SIZE
    # Create a new empty image of the required size
    tmp = NamedTemporaryFile(dir=os.path.dirname(image), delete=False)
    tmp.truncate(size)
    tmp.close()
    new_layout = resize_rootfs_get_sfdisk_script(image, additional_sectors)
    # Write the new layout on the new image.
    sfdisk(tmp.name, _in=new_layout)
    offsets_and_sizes = get_offsets_and_sizes(image, "s")
    copy = partial(ddd, _if=image, of=tmp.name, bs=SECTOR_SIZE, conv="notrunc")
    # Copy partitions 1 and 2.
    for offset, size in offsets_and_sizes[:2]:
        copy(skip=offset, seek=offset, count=size)
    # Copy partitions 3+.
    for offset, size in offsets_and_sizes[2:]:
        copy(skip=offset, seek=offset + additional_sectors, count=size)
    # Expand 2nd partition.
    expand_ext4("root", image=tmp.name)
    # Replace the original image contents.
    ddd(_if=tmp.name, of=image, bs=SECTOR_SIZE)


def get_json(partition_name, path, image=None):
    with mount_context_manager(partition_name, image=image) as mountpoint:
        try:
            with open(os.path.join(mountpoint, path)) as f:
                return json.load(f)
        except FileNotFoundError:
            pass


def get_config(image=None):
    return (
        get_json("boot", "config.json", image=image) or  # resinOS 1.26+
        get_json("conf", "config.json", image=image)  # resinOS 1.8
    )


def get_device_type(image=None):
    return get_json("boot", "device-type.json", image=image)


def get_device_type_slug():
    device_type = get_device_type()
    if device_type is not None:
        return device_type["slug"]
    return get_config()["deviceType"]


def expand_data_partition(additional_space, image=None):
    part = get_partition("data", image)
    log.info("Expanding image size by {}".format(human_size(additional_space)))
    # Add zero bytes to image to be able to resize partitions
    expand_file(part["image"], additional_space)
    # do nothing if the data parition is in its own file
    if part["number"] != 0:
        # This code assumes that the data partition is the 6th and last one
        # and is contained in the 4th (extended) partition.
        assert part["number"] == 6
        log.info(
            "Expanding extended partition 4 and logical partition 6 to the "
            "end of the disk image."
        )
        parted(
            "-s",
            part["image"],
            "resizepart",
            4,
            "100%",
            "resizepart",
            part["number"],
            "100%",
        )


def preload(additional_space, app_data, image=None):
    replace_splash_image(image)
    expand_data_partition(additional_space, image)
    resize_fs_copy_splash_image_and_pull(app_data, image)


def get_inner_image_filename():
    device_type = get_device_type()
    if device_type:
        deployArtifact = device_type["yocto"]["deployArtifact"]
        if "-flasher-" in deployArtifact:
            return deployArtifact.replace("flasher-", "", 1)


def _list_images(image=None):
    driver = get_docker_storage_driver(image=image)
    with mount_context_manager("data", image=image) as mountpoint:
        with docker_context_manager(driver, mountpoint):
            output = docker(
                "--host",
                DOCKER_HOST,
                "images",
                "--all",
                "--format",
                "{{.Repository}}",
            )
            return output.strip().split("\n")


def list_images(detect_flasher_type_images):
    inner_image = get_inner_image_filename()
    if detect_flasher_type_images and inner_image:
        with mount_context_manager("root") as mountpoint:
            inner_image = os.path.join(mountpoint, "opt", inner_image)
            return _list_images(inner_image)
    return _list_images()


def is_non_empty_folder(folder):
    # True if the folder has at least one file not starting with a dot.
    if not os.path.exists(folder) or not os.path.isdir(folder):
        return False
    return any(f for f in os.listdir(folder) if not f.startswith("."))


def find_non_empty_folder_in_path(path, child_dir=""):
    # If child_dir is not given, returns any non empty folder like <path>/...;
    # else, returns any non empty folder like <path>/.../<child_dir>
    # where ... can be any subfodler of <path>.
    if os.path.exists(path) and os.path.isdir(path):
        for folder in os.listdir(path):
            folder_path = os.path.join(path, folder, child_dir)
            if is_non_empty_folder(folder_path):
                return folder_path


def find_docker_aufs_root(mountpoint):
    # We're looking for a /docker/aufs/diff/<xxxxxxxxxxxxx>/ folder with some
    # files not starting with a '.'
    path = os.path.join(mountpoint, "docker", "aufs", "diff")
    return find_non_empty_folder_in_path(path)


def find_docker_overlay2_root(mountpoint):
    # We're looking for a /docker/overlay2/<xxxxxxxxxxxxx>/diff folder with
    # some files not starting with a '.'
    path = os.path.join(mountpoint, "docker", "overlay2")
    return find_non_empty_folder_in_path(path, "diff")


def get_docker_init_file_content(image=None):
    docker_service_file_path = "lib/systemd/system/docker.service"
    with mount_context_manager("root", image=image) as mountpoint:
        docker_root = find_docker_aufs_root(mountpoint)
        if docker_root is None:
            docker_root = find_docker_overlay2_root(mountpoint)
        if docker_root is not None:
            path = os.path.join(docker_root, docker_service_file_path)
        else:
            path = os.path.join(mountpoint, docker_service_file_path)
        with open(path) as f:
            return f.read()


def find_one_of(lst, *args):
    for elem in args:
        index = lst.index(elem)
        if index != -1:
            return index
    return -1


def get_docker_storage_driver(image=None):
    for line in get_docker_init_file_content(image).strip().split("\n"):
        if line.startswith("ExecStart="):
            words = line.split()
            position = find_one_of(words, "-s", "--storage-driver")
            if position != -1 and position < len(words) - 1:
                return words[position + 1]
    # Stop here if no driver was found
    assert False


def main_preload(app_data, container_size, detect_flasher_type_images):
    # Size will be increased by 110% of the container size
    additional_space = round_to_sector_size(ceil(int(container_size) * 1.1))
    inner_image = get_inner_image_filename()
    if not detect_flasher_type_images and inner_image:
        log.info(
            "Warning: This looks like a flasher type image but we're going to "
            "preload it like a regular image."
        )
    if detect_flasher_type_images and inner_image:
        part = get_partition("root")
        log.info(
            "This is a flasher image, preloading into /opt/{} on the 2nd "
            "partition of {}".format(inner_image, part["image"])
        )
        resize_rootfs(additional_space)
        with mount_context_manager("root") as mountpoint:
            image = os.path.join(mountpoint, "opt", inner_image)
            preload(additional_space, app_data, image)
    else:
        preload(additional_space, app_data)


def get_device_type_and_preloaded_builds(detect_flasher_type_images=True):
    return {
        "device_type": get_device_type_slug(),
        "preloaded_builds": list_images(detect_flasher_type_images),
    }


methods = {
    "get_device_type_and_preloaded_builds": (
        get_device_type_and_preloaded_builds
    ),
    "preload": main_preload,
}


if __name__ == "__main__":
    import sys
    for line in sys.stdin:
        data = json.loads(line)
        method = methods[data["command"]]
        result = method(**data.get("parameters", {}))
        print(json.dumps({"result": result}))
