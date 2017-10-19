'use strict'

const _ = require('lodash')
const EventEmitter = require('events')
const dockerProgress = require('docker-progress')
const path = require('path')
const streamModule = require('stream')
const Promise = require('bluebird')
const tar = Promise.promisifyAll(require('tar-stream'))
const fs = Promise.promisifyAll(require('fs'))
const errors = require('resin-errors')
const request = require('request-promise')
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

const CONCURRENT_REQUESTS_TO_REGISTRY = 10
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
  // FIXME: read from the zip directory instead of readin the whole file
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

class Preloader extends EventEmitter {
  constructor (resin, docker, appId, commit, image, splashImage, proxy) {
    super()
    this.resin = resin
    this.docker = docker
    this.appId = appId
    this.commit = commit
    this.image = image
    this.splashImage = splashImage
    this.proxy = proxy
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
  }

  /**
   * Build the preloader docker image
   * @returns Promise
   */
  build () {
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

  prepare () {
    // Check that the image is a writable file
    return this._runWithSpinner('Checking that the image is a writable file', () => {
      return checkImage(this.image)
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
  }

  _prepareErrorHandler () {
    // Emit an error event if the python script exits with an error
    this.container.wait()
    .then((data) => {
      if ((data.StatusCode !== 0) && (data.StatusCode !== EXIT_CAUSED_BY_SIGINT)) {
        const output = this.bufferedStderr.getData().toString('utf8').trim()
        let error
        if ((output.indexOf(GRAPHDRIVER_ERROR) !== -1) && (output.indexOf(DOCKERD_USES_OVERLAY) !== -1)) {
          error = new errors.ResinError(OVERLAY_MODULE_MESSAGE)
        } else {
          error = new Error(output)
          error.code = data.StatusCode
        }
        this.emit('error', error)
      }
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

  _runCommand (command, parameters) {
    return new Promise((resolve, reject) => {
      this.stdout.on('error', (err) => {
        reject(err)
      })
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

  getDeviceTypeAndPreloadedBuilds () {
    // returns Promise<object> (device_type and preloaded_builds)
    return this._runWithSpinner('Reading image device type and preloaded builds', () => {
      return this._runCommand('get_device_type_and_preloaded_builds', {})
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

  _getContainerSize () {
    const imageRepo = getImageRepo(this.application, this.commit)
    const name = `Fetching container size for ${imageRepo}`
    this._progress(name, 0)
    return getRegistryToken(this.resin.pine.API_URL, this.token, this.resinSettings.registry2Url, imageRepo)
    .then((registryToken) => {
      return registry(this.resinSettings.registry2Url, `v2/${imageRepo}/manifests/latest`, registryToken, {}, true, true)
      .then((response) => {
        const layersCount = _.countBy(_.map(response.body.fsLayers, 'blobSum'))
        const size = _.size(layersCount) + 1
        let finished = 1
        const updateProgress = () => {
          this._progress(name, finished / size * 100)
        }
        updateProgress()
        return Promise.map(
          _.entries(layersCount),
          (layer) => {
            return getLayerSize(this.resinSettings.registry2Url, registryToken, imageRepo, layer[0])
            .then((layerSize) => {
              finished += 1
              updateProgress()
              return layerSize * layer[1]
            })
          },
          {concurrency: CONCURRENT_REQUESTS_TO_REGISTRY}
        )
      })
    })
    .reduce((a, b) => a + b)
  }

  preload () {
    const pullingProgressName = 'Pulling image'
    const appData = getAppData(this.resinSettings.registry2Url, this.application, this.commit)
    let percentage = 0
    return this._getContainerSize()
    .then((containerSize) => {
      // Wait for dockerd to start
      return this._runWithSpinner('Resizing partitions and waiting for dockerd to start', () => {
        return this._runCommand('preload', {
          app_data: appData,
          container_size: containerSize
        })
      })
    })
    .then(() => {
      // Docker connection
      const innerDockerProgress = new dockerProgress.DockerProgress({
        Promise,
        host: '0.0.0.0',
        port: this.dockerPort
      })
      this._progress(pullingProgressName, 0)
      // Pull the image
      return innerDockerProgress.pull(appData.imageId, (event) => {
        // Emit progress events while pulling
        percentage = event.percentage
        this._progress(pullingProgressName, event.percentage)
      })
    })
    .then((wat) => {
      if (percentage !== 100) {
        return
      }
      // Signal that we're done to the Python script.
      this.stdin.write('\n')
      if (this.edisonFolder) {
        return this._zipFolder(this.edisonFolder, this.image)
      }
    })
  }

  setApplication (application) {
    this.appId = application.id
    this.application = application
  }

  fetchApplication () {
    return this._runWithSpinner(`Fetching application ${this.appId}`, () => {
      return this.resin.models.application.get(this.appId, {expand: applicationExpandOptions})
      .tap((application) => {
        this.setApplication(application)
      })
    })
  }
}

preload.Preloader = Preloader

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
  return Promise.all([
    fs.accessAsync(image, R_OK | W_OK),
    fs.statAsync(image)
  ])
  .spread((_, stats) => {
    return stats.isFile()
  })
  .catchReturn(false)
}

const checkImage = (image) => {
  return isReadWriteAccessibleFile(image)
  .then((ok) => {
    if (!ok) {
      throw new errors.ResinError('The image must be a read / write accessible file')
    }
  })
}

const registry = (registryHost, endpoint, registryToken, headers, decodeJson, followRedirect, encoding) => {
  headers = Object.assign({}, headers)
  headers['Authorization'] = `Bearer ${registryToken}`
  return request({
    uri: `https://${registryHost}/${endpoint}`,
    headers: headers,
    json: decodeJson,
    simple: false,
    resolveWithFullResponse: true,
    followRedirect,
    encoding
  })
}

const api = (apiHost, apiToken, endpoint, params, headers) => {
  const url = `${apiHost}/${endpoint}`
  params = Object.assign({}, params)
  headers = Object.assign({}, headers)
  headers['Authorization'] = `Bearer ${apiToken}`
  return request({uri: url, qs: params, headers: headers, json: true})
}

const getRegistryToken = (apiHost, apiToken, registryHost, imageRepo) => {
  const params = {
    service: registryHost,
    scope: `repository:${imageRepo}:pull`
  }
  return api(apiHost, apiToken, 'auth/v1/token', params)
  .then((data) => {
    return data['token']
  })
}

const getLayerSize = (registryHost, token, imageRepo, blobSum) => {
  // the last 4 bytes of each gzipped layer are the layer size % 32
  const headers = {Range: 'bytes=-4'}
  // request(...) will re-use the same headers if it gets redirected.
  // We don't want to send the registry token to s3 so we ask it to not follow
  // redirects and issue the second request manually.
  return registry(registryHost, `v2/${imageRepo}/blobs/${blobSum}`, token, headers, false, false, null)
  .then((response) => {
    if (response.statusCode === 206) {
      // no redirect, like in the devenv
      return response
    } else if (response.statusCode === 307) {
      // redirect, like on production or staging
      return request({uri: response.headers.location, headers, resolveWithFullResponse: true, encoding: null})
    } else {
      throw new Error('Unexpected status code from the registry: ' + response.statusCode)
    }
  })
  .then((response) => {
    return response.body.readUIntLE(0, 4)
  })
}

const getAppData = (registryHost, application, commit) => {
  // Extracts application metadata
  const env = {}
  const config = {}
  application.environment_variable.forEach((envvar) => {
    if (envvar.name.startsWith('RESIN_')) {
      config[envvar.name] = envvar.value
    } else {
      env[envvar.name] = envvar.value
    }
  })
  return {
    appId: application.id,
    name: application.app_name,
    commit: commit || application.commit,
    // NOTE: This replaces the registry host in the `imageId` to stop the newer
    // supervisors from re-downloading the app on first boot
    imageId: `${registryHost}/${getImageRepo(application, commit)}`,
    env,
    config
  }
}

const getImageRepo = (application, commit) => {
  return `${application.app_name}/${commit || application.commit}`.toLowerCase()
}

preload.errors = errors

/** @const {String} Container name */
preload.CONTAINER_NAME = 'resin-image-preloader'

const applicationExpandOptions = preload.applicationExpandOptions = {
  environment_variable: {
    $select: ['name', 'value']
  },
  build: {
    $select: ['id', 'commit_hash', 'push_timestamp'],
    $orderby: 'push_timestamp desc',
    $filter: {
      status: 'success'
    }
  }
}

preload.BUILD_HASH_LENGTH = 40
