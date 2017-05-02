const childProcess = require('child_process')
const path = require('path')
const escape = require('command-join')
const preload = module.exports

/** @const {String} Default container name */
preload.CONTAINER_NAME = 'resin-image-preloader'

/**
 * Build the preloader docker image
 * @param {Object} [processOptions] - child process options
 * @returns {ChildProcess}
 */
preload.build = function( processOptions ) {

  processOptions = Object.assign({
    cwd: process.cwd(),
    env: process.env,
    stdio: 'pipe',
    detached: false,
  }, processOptions )

  const dirname = path.join( __dirname, '..' )
  const argv = [ 'build', '-t', 'resin/resin-preload', dirname ]

  return childProcess.spawn( 'docker', argv, processOptions )

}

/**
 * Preload a given image
 * @param {Object} options - Image options
 * @param {String|Number} options.appId - Application ID
 * @param {String} options.image - Path to image to preload
 * @param {String} [options.apiToken] - Resin.io API token
 * @param {String} [options.apiKey] - Resin.io API token
 * @param {String} [options.apiHost] - Resin.io API host
 * @param {String} [options.registry] - Docker registry host
 * @param {String} [options.containerName] - Docker container name
 * @param {Object} [processOptions] - Child process options
 * @returns {ChildProcess}
 */
preload.run = function( options, processOptions ) {

  if( options == null ) {
    throw new Error( 'Missing options argument' )
  }

  processOptions = Object.assign({
    cwd: process.cwd(),
    env: process.env,
    stdio: 'pipe',
    detached: false,
  }, processOptions )

  options.containerName = options.containerName ||
    preload.CONTAINER_NAME

  const argv = [
    'run', '--privileged', '--rm',
    `-e=APP_ID=${escape( options.appId || '' )}`,
    `-e=API_TOKEN=${escape( options.apiToken || '' )}`,
    `-e=API_KEY=${escape( options.apiKey || '' )}`,
    `-e=REGISTRY_HOST=${escape( options.registryHost || '' )}`,
    `-e=API_HOST=${escape( options.apiHost || '' )}`,
    `-v=${( options.image || '' )}:/img/resin.img`,
    `--name=${escape( options.containerName )}`,
    'resin/resin-preload'
  ]

  return childProcess.spawn( 'docker', argv, processOptions )

}
