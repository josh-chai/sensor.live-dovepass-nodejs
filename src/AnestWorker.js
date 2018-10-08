'strict'

const fs = require('fs')
const { MASTER_COMMAND, WORKER_COMMAND, PLUGINS } = require('./AnestConstant')

require('colors')

class AnestWorker {
    constructor() {
        this.instance = null
    }
    run() {
        process.on('message', (message) => {
            if (this.instance === null && message.command === MASTER_COMMAND.START_CONNECTION) {
                this._createInstance(message.data)
            } else if (this.instance !== null && message.command === MASTER_COMMAND.SHADOW_DESIRED) {
                this._desiredInstance(message.data, message.is_local === true)
            } else if (this.instance !== null && message.command === MASTER_COMMAND.TERMINATE_CONNECTION) {
                this._terminateInstance()
            } else {
                console.log(`Connection not ready.`.red)
            }
        })
    }
    _createInstance(config) {
        if (PLUGINS.indexOf(config.type) > -1) {
            try {
                let plugin_file = `${__dirname}/plugins/${config.type}.js`
                if (fs.existsSync(plugin_file)) {
                    const Plugin = require(plugin_file)
                    this.instance = new Plugin(config)
                } else {
                    console.log(`Plugin file: ${plugin_file} lost`)
                }
            } catch (exception) {
                console.log(exception)
            }
        } else {
            console.log(`Connection Type[${config.type}] not allowed.`.red)
        }
    }
    _desiredInstance(state, is_local) {
        this.instance.desired(state, is_local)
    }
    _terminateInstance() {
        this.instance.terminate(() => {
            process.send({
                command: WORKER_COMMAND.TERMINATED
            })
        })
    }
}

module.exports = AnestWorker
