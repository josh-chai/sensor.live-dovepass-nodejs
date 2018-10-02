'strict'

const ModbusSerial = require('modbus-serial')
const net = require('net')
const asyncForEach = require('./AsyncForEach')
const { rtu: functions } = require('./ModbusFunctions')
const encoders = require('./Encoders')
const decoders = require('./Decoders')

class ModbusRTU {
    constructor(config) {
        this.config = config
        this.nodes = {}
        this.client = {}
        this.initialize()
        this.retry_interval = null
    }
    initialize() {
        let options = {
            baudRate: this.config.baud_rate,
            parity: this.config.parity,
            databits: this.config.data_bits,
            stopbits: this.config.stop_bits
        }
        let poll_timeout = parseInt(this.config.poll_timeout) || 5
        this.client = new ModbusSerial()
        this.client.connectRTU(this.config.serial_port, options, (error) => {
            this.client.setTimeout(poll_timeout * 1000)
            if (error) {
                console.log(`[Modbus RTU Connect Failed]\nName: ${this.config.name}\tPort: ${this.config.serial_port}\tBaudRate: ${this.config.baud_rate}`)
                if (this.config.auto_reconnect) {
                    setTimeout(() => {
                        this.initialize()
                    }, this.config.reconnect_timeout * 1000)
                }
                return
            }
            console.log(`[Modbus RTU Connected]\nName: ${this.config.name}\tPort: ${this.config.serial_port}\tBaudRate: ${this.config.baud_rate}`)
            this.scan()
        })
        this.client._port.on('open', () => {
            if (this.retry_interval) {
                clearInterval(this.retry_interval)
                this.retry_interval = null
            }
        })
        this.client._port.on('close', () => {
            if (!this.retry_interval && this.config.auto_reconnect) {
                this.retry_interval = setInterval(() => {
                    this.client._port.open()
                }, this.config.reconnect_timeout * 1000)
            }
        })
        this.client._port.on('error', (error) => {
            // console.log(error)
        })
        this.config.devices.forEach(device => {
            device.nodes.forEach(node => {
                let readable = parseInt(node.function_code, 16) < 5
                this.nodes[`${this.config.name}-${device.slave_id}-${node.property}-${readable ? 'read' : 'write'}`] = node
            })
        })
    }
    async desired(state, is_local) {
        let dataset = {}
        let desired_errors = []
        for (let key in state) {
            let node = this.nodes[`${key}-write`]
            if (!node) {
                console.log(`Desire node[${key}] not exists`)
                continue
            }
            let slave_id = key.replace(/^[^-]*-([^-]*)-.*/, '$1')
            let value = state[key]
            let write_function_code = node.write.function_code
            let write_address = parseInt(node.write.address)
            let encoder = 'set' + node.property.replace(/[-_]/g, ' ').replace(/^([a-z])|\s+([a-z])/g, ($1) => {
                return $1.toUpperCase()
            }).replace(/\x20/g, '')
            if (typeof encoders[encoder] === 'function') {
                value = encoders[encoder](value) || value
            }
            value = parseInt(value)
            await (() => {
                return new Promise((resolve, reject) => {
                    if (this.client.getID() !== parseInt(slave_id)) {
                        this.client.setID(slave_id)
                    }
                    this.client[functions[write_function_code]](write_address, value).then(result => {
                        resolve(result)
                    }).catch(error => {
                        reject(error)
                    })
                })
            })().then(result => {
                dataset[`${this.config.name}-${slave_id}-${node.property}`] = value
            }, error => {
                desired_errors.push(console.log(`[Modbus RTU Write Error]\nName: ${this.config.name}\tPort: ${this.config.serial_port}\tBaudRate: ${this.config.baud_rate}\t${error.message}`))
            })
        }
        if (desired_errors.length > 0) {
            console.log(`[Modbus RTU Write Error]\nName: ${this.config.name}\tPort: ${this.config.serial_port}\tBaudRate: ${this.config.baud_rate}`)
        }
        if (Object.keys(dataset).length > 0) {
            process.send({
                command: is_local ? 'shadowReported' : 'shadowClearDelta',
                payload: dataset
            })
        }
    }
    async scan() {
        let dataset = {}
        let scan_errors = []
        await this.config.devices.asyncForEach(async(device) => {
            this.client.setID(device.slave_id)
            await device.nodes.asyncForEach(async(node) => {
                let read_function_code = node.read.function_code
                let read_address = parseInt(node.read.address)
                let read_quantity = parseInt(node.read.quantity)
                await (() => {
                    return new Promise((resolve, reject) => {
                        this.client[functions[read_function_code]](read_address, read_quantity).then(result => {
                            resolve(result.data)
                        }).catch(error => {
                            reject(error)
                        })
                    })
                })().then(result => {
                    if (read_quantity === 1) {
                        result = result[0]
                    }
                    let decoder = 'get' + node.property.replace(/[-_]/g, ' ').replace(/^([a-z])|\s+([a-z])/g, ($1) => {
                        return $1.toUpperCase()
                    }).replace(/\x20/g, '')
                    if (typeof decoders[decoder] === 'function') {
                        result = decoders[decoder](result) || result
                    }
                    dataset[`${this.config.name}-${device.slave_id}-${node.property}`] = result
                }, error => {
                    scan_errors.push(error)
                })
            })
        })
        if (scan_errors.length > 0) {
            console.log(`[Modbus RTU Scan Error]\nName: ${this.config.name}\tPort: ${this.config.serial_port}\tBaudRate: ${this.config.baud_rate}`)
        }
        if (Object.keys(dataset).length > 0) {
            process.send({
                command: 'shadowReported',
                payload: dataset
            })
        }
        console.log(Object.keys(dataset).length)
        setTimeout(() => {
            this.scan()
        }, (parseInt(this.config.poll_rate) || 5) * 1000)
    }
    terminate(next) {
        this.client.close(() => {
            next()
        })
    }
}

module.exports = ModbusRTU
