'use strict'

const _ = require('lodash')
const EventEmitter = require('events')
const dockerProgress = require('docker-progress')
const path = require('path')
const streamModule = require('stream')
const Promise = require('bluebird')
const tar = Promise.promisifyAll(require('tar-stream'))
const fs = Promise.promisifyAll(require('fs'))
const getPort = require('get-port')
const os = require('os')
const tmp = Promise.promisifyAll(require('tmp'), { multiArgs: true })
const unzipper = require('unzipper')
const archiver = require('archiver')
const getFolderSizeAsync = Promise.promisify(require('get-folder-size'))
const compareVersions = require('compare-versions')

const preload = module.exports

const R_OK = _.isUndefined(fs.constants) ? fs.R_OK : fs.constants.R_OK
const W_OK = _.isUndefined(fs.constants) ? fs.W_OK : fs.constants.W_OK

const DOCKER_IMAGE_TAG = 'resin/resin-preload'
const DISK_IMAGE_PATH_IN_DOCKER = '/img/resin.img'
const SPLASH_IMAGE_PATH_IN_DOCKER = '/img/resin-logo.png'
const DOCKER_STEP_RE = /Step (\d+)\/(\d+)/
const EXIT_CAUSED_BY_SIGINT = 137

const GRAPHDRIVER_ERROR = 'Error starting daemon: error initializing graphdriver: driver not supported'
const OVERLAY_MODULE_MESSAGE = 'You need to load the "overlay" module to be able to preload this image: run "sudo modprobe overlay".'
const DOCKERD_USES_OVERLAY = '--storage-driver=overlay2'

const PARTITION_NAMES = [ 'resin-boot', 'resin-rootA', 'resin-data' ]

const FLASH_EDISON_FILENAME = 'FlashEdison.json'
const EDISON_PARTITION_FILE_KEYS = {
  'resin-boot': 'boot_file',
  'resin-rootA': 'rootfs_file',
  'resin-data': 'resin-data_file'
}

const getEdisonPartitions = (edisonFolder) => {
  // The replace is needed because this file contains new lines in strings, which is not valid JSON.
  const data = JSON.parse(fs.readFileSync(path.join(edisonFolder, FLASH_EDISON_FILENAME), 'utf8').replace(/\n/g, ''))
  const parameters = data.flash.parameters
  const result = {}
  PARTITION_NAMES.forEach((name) => {
    result[name] = {
      file: path.join(edisonFolder, parameters[EDISON_PARTITION_FILE_KEYS[name]].value),
      image: `/img/${name}`
    }
  })
  return result
}

class BufferBackedWritableStream extends streamModule.Writable {
  constructor () {
    super(arguments)
    this.chunks = []
  }

  _write (chunk, enc, next) {
    this.chunks.push(chunk)
    next()
  }

  getData () {
    return Buffer.concat(this.chunks)
  }
}

const tarFiles = (dir, filenames) => {
  let fullPath
  const pack = tar.pack()
  return Promise.map(filenames, (filePath) => {
    fullPath = path.join(dir, filePath)
    return Promise.join(fs.statAsync(fullPath), fs.readFileAsync(fullPath), (stats, data) => {
      return pack.entryAsync({ name: filePath, size: stats.size, mode: stats.mode }, data)
    })
  })
  .then(() => {
    pack.finalize()
    return pack
  })
}

const bindMount = (source, target, dockerApiVersion) => {
  source = path.resolve(source)
  if (compareVersions(dockerApiVersion, '1.25') >= 0) {
    return {
      Source: source,
      Target: target,
      Type: 'bind',
      Consistency: 'delegated'
    }
  } else {
    return `${source}:${target}`
  }
}

const zipContainsFiles = (archive, files) => {
  // FIXME: read from the zip directory instead of reading the whole file
  // This is broken in unzipper for now: an invalid zip file will throw an
  // uncaught error event.
  const filesCopy = files.slice()
  return new Promise((resolve, reject) => {
    fs.createReadStream(archive)
    .on('error', reject)
    .pipe(unzipper.Parse())
    .on('error', reject)
    .on('entry', function (entry) {
      _.pull(filesCopy, entry.path)
      entry.autodrain()
    })
    .on('finish', () => {
      resolve(filesCopy.length === 0)
    })
  })
}

const isEdisonZipArchive = (file) => {
  return zipContainsFiles(file, [ FLASH_EDISON_FILENAME ])
  .catchReturn(false)
}

const createContainer = (docker, image, splashImage, dockerPort, proxy, edisonFolder) => {
  const mounts = []
  return docker.version()
  .then((version) => {
    if (splashImage) {
      mounts.push(bindMount(splashImage, SPLASH_IMAGE_PATH_IN_DOCKER, version.ApiVersion))
    }

    const env = [
      `HTTP_PROXY=${proxy || ''}`,
      `HTTPS_PROXY=${proxy || ''}`,
      `DOCKER_PORT=${dockerPort || ''}`
    ]

    if (edisonFolder) {
      const partitions = getEdisonPartitions(edisonFolder)
      env.push(`PARTITIONS=${JSON.stringify(partitions)}`)
      PARTITION_NAMES.forEach((name) => {
        const part = partitions[name]
        mounts.push(bindMount(part.file, part.image, version.ApiVersion))
      })
    } else {
      mounts.push(bindMount(image, DISK_IMAGE_PATH_IN_DOCKER, version.ApiVersion))
    }
    const containerOptions = {
      Image: DOCKER_IMAGE_TAG,
      Name: preload.CONTAINER_NAME,
      AttachStdout: true,
      AttachStderr: true,
      OpenStdin: true,
      Env: env,
      HostConfig: {
        Privileged: true
      }
    }
    // Before api 1.25 bind mounts were going to into HostConfig.Binds
    containerOptions.HostConfig[(compareVersions(version.ApiVersion, '1.25') >= 0) ? 'Mounts' : 'Binds'] = mounts
    if (os.platform() === 'linux') {
      containerOptions.HostConfig.NetworkMode = 'host'
    } else {
      containerOptions.HostConfig.NetworkMode = 'bridge'
      containerOptions.ExposedPorts = {}
      containerOptions.ExposedPorts[`${dockerPort}/tcp`] = {}
      containerOptions.HostConfig.PortBindings = {}
      containerOptions.HostConfig.PortBindings[`${dockerPort}/tcp`] = [{
        HostPort: `${dockerPort}`,
        HostIp: ''
      }]
    }
    return docker.createContainer(containerOptions)
  })
}

const isReadWriteAccessibleFile = (image) => {
  return Promise.join(fs.accessAsync(image, R_OK | W_OK), fs.statAsync(image), (_, stats) => {
    return stats.isFile()
  })
  .catchReturn(false)
}

class Preloader extends EventEmitter {
  constructor (resin, docker, appId, commit, image, splashImage, proxy, dontCheckDeviceType) {
    super()
    this.resin = resin
    this.docker = docker
    this.appId = appId
    this.commit = commit
    this.image = image
    this.splashImage = splashImage
    this.proxy = proxy
    this.dontCheckDeviceType = dontCheckDeviceType
    this.application = null
    this.stdin = null
    this.stdout = new streamModule.PassThrough()
    this.stderr = new streamModule.PassThrough()
    this.bufferedStderr = new BufferBackedWritableStream()
    this.stderr.pipe(this.bufferedStderr)  // TODO: split stderr and build output ?
    this.edisonFolder = null
    this.dockerPort = null
    this.container = null
    this.tmpCleanup = null
    this.resinSettings = null
    this.token = null
    this.state = null  // device state from the api
    this.freeSpace = null  // space available on the image data partition (in bytes)
    this.preloadedBuilds = null  // list of preloaded Docker images in the disk image
    this.supervisorVersion = null  // disk image supervisor version
    this.config = null  // config.json data from the disk image
  }

  /**
   * Build the preloader docker image
   * @returns Promise
   */
  _build () {
    const files = ['Dockerfile', 'requirements.txt', 'src/preload.py']
    const name = 'Building Docker preloader image.'
    this._progress(name, 0)

    return tarFiles(path.resolve(__dirname, '..'), files)
    .then((tarStream) => {
      return this.docker.buildImage(tarStream, { t: DOCKER_IMAGE_TAG })
    })
    .then((build) => {
      return new Promise((resolve, reject) => {
        this.docker.modem.followProgress(
          build,
          (error, output) => {  // onFinished
            if (error) {
              reject(error)
            } else {
              this._progress(name, 100)
              resolve()
            }
          },
          (event) => {  // onProgress
            if (event.stream) {
              const matches = event.stream.match(DOCKER_STEP_RE)
              if (matches) {
                this._progress(name, parseInt(matches[1]) / (parseInt(matches[2]) + 1) * 100)
              }
              this.stderr.write(event.stream)
            }
          }
        )
      })
    })
  }

  _unzipFiles (archive, folder) {
    // archive is the path to a zip file
    const name = 'Unzipping Edison zip archive'
    let position = 0
    this._progress(name, 0)
    return fs.statAsync(archive)
    .then((stat) => {
      return fs.createReadStream(archive)
      .on('data', (buf) => {
        position += buf.length
        this._progress(name, position / stat.size * 100)
      })
      .pipe(unzipper.Extract({ path: folder }))
      .promise()
    })
  }

  _zipFolder (folder, destination) {
    const name = 'Zipping back files into Edison zip archive'
    let position = 0
    this._progress(name, 0)
    return getFolderSizeAsync(folder)
    .then((size) => {
      return new Promise((resolve, reject) => {
        const archive = archiver('zip', { zlib: { level: 9 } })
        archive.on('warning', console.warn)
        archive.on('error', reject)
        archive.on('entry', (entry) => {
          position += entry.stats.size
          this._progress(name, position / size * 100)
        })
        archive.directory(folder, false)
        archive.finalize()
        const output = fs.createWriteStream(destination)
        output.on('error', reject)
        output.on('close', () => {
          this._progress(name, 100)
          resolve()
        })
        archive.pipe(output)
      })
    })
  }

  _runWithSpinner (name, fn) {
    this._startSpinner(name)
    return fn()
    .finally(() => {
      this._stopSpinner(name)
    })
  }

  _prepareErrorHandler () {
    // Emit an error event if the python script exits with an error
    this.container.wait()
    .then((data) => {
      if ((data.StatusCode !== 0) && (data.StatusCode !== EXIT_CAUSED_BY_SIGINT)) {
        const output = this.bufferedStderr.getData().toString('utf8').trim()
        let error
        if ((output.indexOf(GRAPHDRIVER_ERROR) !== -1) && (output.indexOf(DOCKERD_USES_OVERLAY) !== -1)) {
          error = new this.resin.errors.ResinError(OVERLAY_MODULE_MESSAGE)
        } else {
          error = new Error(output)
          error.code = data.StatusCode
        }
        this.emit('error', error)
      }
    })
  }

  _runCommand (command, parameters) {
    return new Promise((resolve, reject) => {
      this.stdout.once('error', reject)
      this.stdout.once('data', (data) => {
        resolve(JSON.parse(data).result)
      })
      this.stdin.write(JSON.stringify({ command, parameters }) + '\n')
    })
  }

  _startSpinner (name) {
    this.emit('spinner', { name, action: 'start' })
  }

  _stopSpinner (name) {
    this.emit('spinner', { name, action: 'stop' })
  }

  _progress (name, percentage) {
    this.emit('progress', { name, percentage })
  }

  _getState () {
    const uuid = this.resin.models.device.generateUniqueKey()
    return this.resin.models.device.register(this.application.id, uuid)
    .then((deviceInfo) => {
      return this.resin.pine.patch({
        resource: 'device',
        id: deviceInfo.id,
        body: {
          should_be_running__release: this._getRelease().id
        }
      })
    })
    .then(() => {
      return this.resin.request.send({
        baseUrl: this.resin.pine.API_URL,
        url: `device/v2/${uuid}/state`
      })
    })
    .get('body')
    .then((state) => {
      this.state = state
      return this.resin.models.device.remove(uuid)
    })
  }

  _getImageInfo () {
    // returns Promise<object> (device_type, preloaded_builds, free_space and config)
    return this._runWithSpinner('Reading image information', () => {
      return this._runCommand('get_image_info', {})
      .tap((info) => {
        this.freeSpace = info.free_space
        this.preloadedBuilds = info.preloaded_builds
        this.supervisorVersion = info.supervisor_version
        this.config = info.config
      })
    })
  }

  _getCommit () {
    return this.commit || this.application.commit
  }

  _getRelease () {
    const commit = this._getCommit()
    const release = _.find(this.application.owns__release, (release) => {
      return release.commit.startsWith(commit)
    })
    if (!release) {
      throw new this.resin.errors.ResinReleaseNotFound(commit)
    }
    return release
  }

  _getImages () {
    return this._getRelease().contains__image.map((ci) => {
      const result = _.clone(ci.image[0])
      result.is_stored_at__image_location = result.is_stored_at__image_location.toLowerCase()
      return result
    })
  }

  _getLegacyAppsJson () {
    // Converts new state endpoint response to the old apps.json format
    const appData = this.state.local
    const app = appData.apps[this.application.id]
    const service = _.values(app.services)[0]
    return [
      {
        appId: this.application.id,
        commit: app.commit,
        config: appData.config,
        env: service.environment,
        imageId: service.image,
        name: app.name
      }
    ]
  }

  _getImagesToPreload () {
    const preloaded = new Set(this.preloadedBuilds)
    const toPreload = new Set(this._getImages())
    for (let image of toPreload) {
      if (preloaded.has(image.is_stored_at__image_location)) {
        toPreload.delete(image)
      }
    }
    return Array.from(toPreload)
  }

  _getRequiredAdditionalSpace () {
    const size = _.sum(_.map(this._getImagesToPreload(), 'image_size')) * 1.1
    return Math.max(0, (size - this.freeSpace))
  }

  _supervisorLT7 () {
    try {
      return (compareVersions(this.supervisorVersion, '7.0.0') === -1)
    } catch (e) {
      // Suppose the supervisor version is >= 7.0.0 when it is not valid semver.
      return false
    }
  }

  _getAppsJson () {
    return this._supervisorLT7() ? this._getLegacyAppsJson() : this.state.local
  }

  _getRegistryToken (images) {
    return this.resin.request.send({
      baseUrl: this.resin.pine.API_URL,
      url: '/auth/v1/token',
      qs: {
        service: this.resinSettings.registry2Url,
        scope: images.map((imageRepository) => `repository:${imageRepository.substr(imageRepository.search('/') + 1)}:pull`)
      }
    })
    .get('body')
    .get('token')
  }

  _fetchApplication () {
    if (this.application || !this.appId) {
      return Promise.resolve()
    }
    return this._runWithSpinner(`Fetching application ${this.appId}`, () => {
      return this.resin.models.application.get(this.appId, {expand: applicationExpandOptions})
      .then((application) => {
        this.setApplication(application)
      })
    })
  }

  _checkImage (image) {
    return isReadWriteAccessibleFile(image)
    .then((ok) => {
      if (!ok) {
        throw new this.resin.errors.ResinError('The image must be a read/write accessible file')
      }
    })
  }

  _pluralize (count, thing) {
    return `${count} ${thing}${(count !== 1) ? 's' : ''}`
  }

  prepare () {
    return this._build()
    .then(() => {
      // Check that the image is a writable file
      return this._runWithSpinner('Checking that the image is a writable file', () => {
        return this._checkImage(this.image)
      })
    })
    .then(() => {
      // Get a free tcp port and resin sdk settings
      return this._runWithSpinner('Finding a free tcp port and getting resin settings', () => {
        return Promise.all([getPort(), this.resin.settings.getAll(), this.resin.auth.getToken()])
      })
    })
    .spread((port, resinSettings, token) => {
      this.dockerPort = port
      this.resinSettings = resinSettings
      this.token = token
      // Check if the image is a regular disk image or an Edison zip archive
      return this._runWithSpinner('Checking if the image is an edison zip archive', () => {
        return isEdisonZipArchive(this.image)
      })
    })
    .then((isEdison) => {
      // If the image is an Edison zip archive extract it to a temporary folder.
      if (isEdison) {
        const tmpDirOptions = { unsafeCleanup: true }
        if (os.platform() === 'darwin') {
          // Docker on mac can not access /var/folders/... by default which is where $TMPDIR is on macos.
          // https://docs.docker.com/docker-for-mac/osxfs/#namespaces
          tmpDirOptions.dir = '/tmp'
        }
        return tmp.dirAsync(tmpDirOptions)
        .spread((folder, cleanup) => {
          this.edisonFolder = folder
          this.tmpCleanup = Promise.promisify(cleanup)
          return this._unzipFiles(this.image, folder)
        })
      }
    })
    .then(() => {
      // Create the docker preloader container
      return this._runWithSpinner('Creating preloader container', () => {
        return createContainer(this.docker, this.image, this.splashImage, this.dockerPort, this.proxy, this.edisonFolder)
      })
    })
    .then((container) => {
      this.container = container
      return this._runWithSpinner('Starting preloader container', () => {
        return this.container.start()
      })
    })
    .then(() => {
      this._prepareErrorHandler()

      return this.container.attach({ stream: true, stdout: true, stderr: true, stdin: true })
    })
    .then((stream) => {
      this.stdin = stream
      this.docker.modem.demuxStream(stream, this.stdout, this.stderr)
    })
    .then(() => {
      return this._fetchApplication()
    })
    .then(() => {
      return this._getImageInfo()
    })
  }

  cleanup () {
    // Returns Promise
    // Deletes the container and the temporary edison folder if it was created
    return this._runWithSpinner('Cleaning up temporary files', () => {
      return Promise.try(() => {
        if (this.container) {
          return Promise.all([this.kill(), this.container.wait()])
          .then(() => {
            return this.container.remove()
          })
        }
      })
      .then(() => {
        if (this.tmpCleanup) {
          return this.tmpCleanup()
        }
      })
    })
  }

  kill () {
    // returns Promise
    if (this.container) {
      return this.container.kill()
      .catchReturn()
    }
    return Promise.resolve()
  }

  _ensureCanPreload () {
    // Throws a ResinError if preloading is not possible
    let msg

    // No releases
    if (this.application.owns__release.length === 0) {
      msg = 'This application has no successful releases'
      throw new this.resin.errors.ResinError(msg)
    }

    // Don't preload if the image device type does not match the application device type
    if (this.dontCheckDeviceType === false && this.config.deviceType !== this.application.device_type) {
      msg = `Application device type (${this.application.device_type}) and image device type (${this.config.deviceType}) do not match.`
      throw new this.resin.errors.ResinError(msg)
    }

    // Don't preload a multicontainer app on an image which supervisor version is older than 7.0.0
    if ((this._getImages().length > 1) && this._supervisorLT7()) {
      msg = `Can't preload a multicontainer app on an image which supervisor version is < 7.0.0 (${this.supervisorVersion}).`
      throw new this.resin.errors.ResinError(msg)
    }

    // No new images to preload
    if (this._getImagesToPreload().length === 0) {
      msg = 'Nothing new to preload.'
      throw new this.resin.errors.ResinError(msg)
    }
  }

  preload () {
    this._ensureCanPreload()
    const additionalBytes = this._getRequiredAdditionalSpace()
    const images = _.map(this._getImagesToPreload(), 'is_stored_at__image_location')
    return this._getState()
    .then(() => {
      const appData = this._getAppsJson()
      // Wait for dockerd to start
      return this._runWithSpinner('Resizing partitions and waiting for dockerd to start', () => {
        return this._runCommand('preload', {
          app_data: appData,
          additional_bytes: additionalBytes
        })
      })
    })
    .then(() => {
      return this._getRegistryToken(images)
    })
    .then((registryToken) => {
      const opts = { authconfig: { registrytoken: registryToken } }
      // Docker connection
      const innerDockerProgress = new dockerProgress.DockerProgress({
        Promise,
        host: '0.0.0.0',
        port: this.dockerPort
      })
      const pullingProgressName = `Pulling ${this._pluralize(images.length, 'image')}`
      // Emit progress events while pulling
      const onProgressHandlers = innerDockerProgress.aggregateProgress(images.length, (e) => {
        this._progress(pullingProgressName, e.percentage)
      })
      return Promise.map(images, (image, index) => {
        return innerDockerProgress.pull(image, onProgressHandlers[index], opts)
      })
    })
    .then(() => {
      // Signal that we're done to the Python script.
      this.stdin.write('\n')
      // Wait for the script to unmount the data partition
      return new Promise((resolve, reject) => {
        this.stdout.once('error', reject)
        this.stdout.once('data', resolve)
      })
    })
    .then(() => {
      if (this.edisonFolder) {
        return this._zipFolder(this.edisonFolder, this.image)
      }
    })
  }

  setApplication (application) {
    this.appId = application.id
    this.application = application
  }
}

preload.Preloader = Preloader

/** @const {String} Container name */
preload.CONTAINER_NAME = 'resin-image-preloader'

const applicationExpandOptions = preload.applicationExpandOptions = {
  owns__release: {
    $select: ['id', 'commit', 'end_timestamp', 'composition'],
    $orderby: 'end_timestamp desc',
    $expand: {
      contains__image: {
        $select: ['image'],
        $expand: {
          image: {
            $select: ['image_size', 'is_stored_at__image_location']
          }
        }
      }
    },
    $filter: {
      status: 'success'
    }
  }
}
