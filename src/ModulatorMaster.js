const cluster = require('cluster')
const IotClient = require('./IotClient')
const JobsClient = require('./JobsClient')
const Storage = require('./Storage')

const SerialPort = require('serialport')
const CronJob = require('cron').CronJob

const {
    PLUGINS,
    STORAGE_PATH,
    MASTER_COMMAND
} = require('./ModulatorConstant')

class ModulatorMaster {
    constructor({ thing_name, endpoint, keys_path, port = 8883, enable_log = false, enable_debug = false }) {
        this.thing_name = thing_name
        this.keys_path = keys_path
        this.endpoint = endpoint
        this.port = port
        this.enable_log = enable_log
        this.enable_debug = enable_debug
        this.iot_client = null
        this.jobs_client = null
        this.connection = null
        this.schedule = null
        this.rule = null
        this.storage = new Storage()
    }
    async run() {
        if (this.enable_log) {
            require('colors')
        }
        await this.initialIotClient().then(iot_client => {
            this.log('IoT client connected', 'success')
            this.iot_client = iot_client
            this.registerThingShadowEvents()
        }, error => {
            this.log('IoT client connect failed', error, 'error')
            process.exit()
        })
        await this.initialConnections().then(connections => {
            this.log('Connections initial success', 'success')
        }, error => {
            this.log('Connections initial failed', error, 'error')
            process.exit()
        })
        await this.initialJobClient().then(jobs_client => {
            this.log('Jobs client connected', 'success')
            this.jobs_client = jobs_client
            this.registerSetConnectionJob()
            this.registerDeleteConnectionJob()
            this.registerSetScheduleJob()
            this.registerDeleteScheduleJob()
            this.registerSetRuleJob()
            this.registerDeleteRuleJob()
        }, error => {
            this.log('Jobs client connect failed', error, 'error')
            process.exit()
        })
        await this.initialSchedules().then(schedules => {
            this.log('Schedules initial success', 'success')
        }, error => {
            this.log('Schedules initial failed', error, 'error')
        })
        await this.initialRules().then(schedules => {
            this.log('Rules initial success', 'success')
        }, error => {
            this.log('Rules initial failed', error, 'error')
        })
        this.processRules()
    }
    initialIotClient() {
        return new Promise((resolve, reject) => {
            let iot_client = new IotClient(this.thing_name, {
                keys_path: this.keys_path,
                endpoint: this.endpoint,
                port: this.port,
                debug: this.enable_debug
            })
            iot_client.on('connect', () => {
                iot_client.register((error) => {
                    if (error) {
                        reject(error)
                    } else {
                        resolve(iot_client)
                    }
                })
            })
            iot_client.on('error', (error) => {
                reject(error)
            })
        })
    }
    registerThingShadowEvents() {
        this.iot_client.on('request_information', (topic, fields) => {
            for (let field of fields) {
                let method = 'report' + field.replace(/[-_]/g, ' ').replace(/^([a-z])|\s+([a-z])/g, ($1) => {
                    return $1.toUpperCase()
                }).replace(/\x20/g, '')
                if (typeof this.$information()[method] === 'function') {
                    let promise = this.$information()[method]()
                    if (promise instanceof Promise) {
                        promise.then(result => {
                            this.iot_client.publish(`@dovepass/things/${this.thing_name}/information/get/accepted`, JSON.stringify({
                                [field]: result
                            }))
                        }, error => {
                            this.log(`Can't get field[${field}]`, error, 'error')
                        })
                    }
                }
            }
        })
        this.iot_client.on('delta', (thing_name, document) => {
            this.executeDesired(document.state, false)
        })
    }
    initialJobClient() {
        return new Promise((resolve, reject) => {
            let jobs_client = new JobsClient(this.thing_name, {
                keys_path: this.keys_path,
                endpoint: this.endpoint,
                port: this.port,
                debug: this.enable_debug
            })
            jobs_client.on('connect', () => {
                jobs_client.start((error) => {
                    if (error) {
                        reject(error)
                    } else {
                        resolve(jobs_client)
                    }
                })
            })
            jobs_client.on('error', (error) => {
                reject(error)
            })
        })
    }
    $connection() {
        let that = this
        if (!this.connection) {
            this.connection = {
                connections: {},
                create(config) {
                    if (!this.validate(config)) {
                        return null
                    }
                    let parent = this
                    this.connections[config.id] = {
                        id: config.id,
                        name: config.name,
                        config: config,
                        worker: null,
                        dataset: null,
                        timer: null,
                        start() {
                            this.worker = cluster.fork()
                            this.worker.on('online', () => {
                                this.worker.send({
                                    command: MASTER_COMMAND.START_CONNECTION,
                                    data: this.config
                                })
                            })
                            this.worker.on('disconnect', () => {
                                clearTimeout(this.timer)
                                delete parent.connections[this.name]
                            })
                            this.worker.on('message', (message) => {
                                switch (message.command) {
                                    case 'shadow_reported':
                                        this.dataset = message.payload
                                        break
                                    case 'shadow_clear_delta':
                                        let desired = {}
                                        for (let property in message.payload) {
                                            desired[property] = null
                                        }
                                        that.iot_client.updateThingShadow({
                                            state: {
                                                reported: message.payload || {},
                                                desired
                                            }
                                        })
                                        break
                                    case 'terminated':
                                        this.worker.kill()
                                        break
                                }
                            })
                            this.updateThingShadow()
                            return this
                        },
                        desired(state, is_local) {
                            this.worker.send({
                                command: MASTER_COMMAND.SHADOW_DESIRED,
                                data: state,
                                is_local
                            })
                            return this
                        },
                        updateThingShadow() {
                            this.timer = setTimeout(() => {
                                if (this.dataset) {
                                    that.iot_client.updateThingShadow({
                                        state: {
                                            reported: this.dataset
                                        }
                                    })
                                }
                                this.updateThingShadow()
                            }, this.config.shadow_report_rate)
                        }
                    }
                    this.connections[config.id].start()
                    return this.connections[config.id]
                },
                get(id) {
                    return this.connections[id] || null
                },
                getByName(name) {
                    let id = Object.keys(this.connections).filter(id => {
                        return this.connections[id].name === name
                    }).shift()
                    return this.connections[id] || null
                },
                remove(id) {
                    let connection = this.get(id)
                    if (connection) {
                        connection.worker.send({
                            command: MASTER_COMMAND.TERMINATE_CONNECTION
                        })
                    }
                    return this
                },
                reportThingShadow() {
                    that.iot_client.updateThingShadow({
                        state: {
                            reported: {
                                connections: Object.keys(this.connections)
                            }
                        }
                    })
                    return this
                },
                validate(config) {
                    return PLUGINS.indexOf(config.type) > -1 && config.id !== '' && config.name !== ''
                },
                collapseDatasets() {
                    let datasets = {}
                    for (let id in this.connections) {
                        let connection = this.connections[id]
                        datasets = {
                            ...datasets,
                            ...connection.dataset
                        }
                    }
                    return datasets
                }
            }
        }
        return this.connection
    }
    initialConnections() {
        return new Promise((resolve, reject) => {
            try {
                let files = this.storage.getConnectionsConfig()
                for (let file of files) {
                    let config = require(`${STORAGE_PATH}/${file}`)
                    let connection = this.$connection().create(config)
                    if (connection) {
                        this.log(`Connection [${connection.name}] started`, 'success')
                    } else {
                        this.log(`Connection [${connection.name}] start failed`, 'error')
                    }
                }
                this.$connection().reportThingShadow()
                resolve(this.connections)
            } catch (exception) {
                reject(exception)
            }
        })
    }
    registerSetConnectionJob() {
        this.jobs_client.on('SetConnection', (config, next) => {
            let connection = this.$connection().get(config.id)
            if (connection) {
                this.$connection().remove(config.id)
                this.log(`Connection [${connection.name}] stopped`, 'success')
            }
            let new_connection = this.$connection().create(config)
            if (new_connection) {
                this.log(`Connection [${new_connection.name}] started`, 'success')
                this.$connection().reportThingShadow()
                this.storage.storeConnectionConfig(config)
                next(true)
            } else {
                next(false)
            }
        })
    }
    registerDeleteConnectionJob() {
        this.jobs_client.on('DeleteConnection', (config, next) => {
            let connection = this.$connection().get(config.id)
            if (connection) {
                this.$connection().remove(config.id).reportThingShadow()
                this.storage.deleteConnectionConfig(config)
                this.log(`Schedule [${connection.name}] stopped.`, 'success')
            }
            next(true)
        })
    }
    $schedule() {
        let that = this
        if (!this.schedule) {
            this.schedule = {
                schedules: {},
                create(config) {
                    if (!this.validate(config)) {
                        return null
                    }
                    this.schedules[config.id] = {
                        id: config.id,
                        name: config.name,
                        cron: new CronJob(config.expression, () => {
                            let actions = {}
                            for (let action of config.actions) {
                                actions[action.command] = action.value
                            }
                            that.executeDesired(actions, true)
                            setTimeout(() => {
                                let thens = {}
                                for (let then of config.thens) {
                                    thens[then.command] = then.value
                                }
                                that.executeDesired(thens, true)
                            }, config.after)
                        }, null, true, 'UTC')
                    }
                    return this.schedules[config.id]
                },
                remove(id) {
                    let schedule = this.get(id)
                    if (schedule) {
                        schedule.cron.stop()
                        delete this.schedules[id]
                    }
                    return this
                },
                get(id) {
                    return this.schedules[id] || null
                },
                reportThingShadow() {
                    that.iot_client.updateThingShadow({
                        state: {
                            reported: {
                                schedules: Object.keys(this.schedules)
                            }
                        }
                    })
                    return this
                },
                validate(config) {
                    return config.id !== '' && config.name !== ''
                }
            }
        }
        return this.schedule
    }
    initialSchedules() {
        return new Promise((resolve, reject) => {
            try {
                let files = this.storage.getSchedulesConfig()
                for (let file of files) {
                    let config = require(`${STORAGE_PATH}/${file}`)
                    let schedule = this.$schedule().create(config)
                    if (schedule) {
                        this.log(`Schedule [${schedule.name}] started.`, 'success')
                    } else {
                        this.log(`Schedule [${config.name}] start failed`, 'error')
                    }
                }
                this.$schedule().reportThingShadow()
                resolve(true)
            } catch (exception) {
                reject(exception)
            }
        })
    }
    registerSetScheduleJob() {
        this.jobs_client.on('SetSchedule', (config, next) => {
            let schedule = this.$schedule().get(config.id)
            if (schedule) {
                this.$schedule().remove(config.id)
                this.log(`Schedule [${schedule.name}] stopped.`, 'success')
            }
            let new_schedule = this.$schedule().create(config)
            if (new_schedule) {
                this.$schedule().reportThingShadow()
                this.storage.storeScheduleConfig(config)
                this.log(`Schedule [${new_schedule.name}] started.`, 'success')
                next(true)
            } else {
                next(false)
            }
        })
    }
    registerDeleteScheduleJob() {
        this.jobs_client.on('DeleteSchedule', (config, next) => {
            let schedule = this.$schedule().get(config.id)
            if (schedule) {
                this.$schedule().remove(config.id).reportThingShadow()
                this.storage.deleteScheduleConfig(config)
                this.log(`Schedule [${schedule.name}] stopped.`, 'success')
            }
            next(true)
        })
    }
    executeDesired(actions, is_local) {
        let state_groups = {}
        for (let property in actions) {
            let name = property.replace(/^([^-]*)-(.*)/, '$1')
            if (!state_groups[name]) {
                state_groups[name] = {}
            }
            state_groups[name][property] = actions[property]
        }
        for (let name in state_groups) {
            let desired_state = state_groups[name]
            let current_connection = this.$connection().getByName(name)
            if (current_connection) {
                current_connection.desired(desired_state, is_local)
            }
        }
    }
    $rule() {
        let that = this
        if (!this.rule) {
            this.rule = {
                rules: {},
                create(config) {
                    if (!this.validate(config)) {
                        return null
                    }
                    this.rules[config.id] = config
                    return this.rules[config.id]
                },
                remove(id) {
                    let rule = this.get(id)
                    if (rule) {
                        delete this.rules[id]
                    }
                    return this
                },
                get(id) {
                    return this.rules[id] || null
                },
                all() {
                    return this.rules
                },
                reportThingShadow() {
                    that.iot_client.updateThingShadow({
                        state: {
                            reported: {
                                rules: Object.keys(this.rules)
                            }
                        }
                    })
                    return this
                },
                validate(config) {
                    return config.id !== '' && config.name !== ''
                }
            }
        }
        return this.rule
    }
    initialRules() {
        return new Promise((resolve, reject) => {
            try {
                let files = this.storage.getRulesConfig()
                for (let file of files) {
                    let config = require(`${STORAGE_PATH}/${file}`)
                    let rule = this.$rule().create(config)
                    if (rule) {
                        this.log(`Rule [${rule.name}] started.`, 'success')
                    } else {
                        this.log(`Rule [${rule.name}] start failed`, 'error')
                    }
                }
                this.$rule().reportThingShadow()
                resolve(true)
            } catch (exception) {
                reject(exception)
            }
        })
    }
    registerSetRuleJob() {
        this.jobs_client.on('SetRule', (config, next) => {
            let rule = this.$rule().get(config.id)
            if (rule) {
                this.$rule().remove(config.id)
                this.log(`Rule [${rule.name}] stopped.`, 'success')
            }
            let new_rule = this.$rule().create(config)
            if (new_rule) {
                this.$rule().reportThingShadow()
                this.storage.storeRuleConfig(config)
                this.log(`Rule [${new_rule.name}] started.`, 'success')
                next(true)
            } else {
                next(false)
            }
        })
    }
    registerDeleteRuleJob() {
        this.jobs_client.on('DeleteRule', (config, next) => {
            let rule = this.$rule().get(config.id)
            if (rule) {
                this.$rule().remove(config.id).reportThingShadow()
                this.storage.deleteRuleConfig(config)
                this.log(`Rule [${rule.name}] stopped.`, 'success')
            }
            next(true)
        })
    }
    processRules() {
        return new Promise(resolve => {
            setInterval(() => {
                this.executeRules()
            }, 1000)
            resolve(true)
        })
    }
    executeRules() {
        let payload = this.$connection().collapseDatasets()
        let rules = this.$rule().all()
        for (let rule_id in rules) {
            let rule = rules[rule_id]
            let do_action = false
            let executes = []
            for (let condition of rule.conditions) {
                let operator = '==='
                switch (condition.operator) {
                    case '=':
                        operator = '=='
                        break
                    default:
                        operator = condition.operator
                        break
                }
                executes.push(`(payload['${condition.property}'] ${operator} ${condition.value})`)
            }
            eval(`do_action = ${executes.join(' && ')}`)
            if (do_action) {
                let actions = {}
                for (let action of rule.actions) {
                    actions[action.command] = action.value
                }
                this.executeDesired(actions, true)
            } else {
                // console.log('not thing to do')
            }
        }
    }
    $information() {
        return {
            reportSerialPorts() {
                return new Promise((resolve, reject) => {
                    SerialPort.list().then(result => {
                        let ports = result.map(port => {
                            return port.comName
                        })
                        resolve(ports)
                    }, error => {
                        reject(error)
                    })
                })
            }
        }
    }
    log(message, detail, type) {
        if (this.enable_log) {
            let colors = {
                'success': 'green',
                'error': 'red',
                'waring': 'yellow',
                'info': 'cyan'
            }
            if (type === undefined) {
                type = detail
                console.log(message[colors[type] || 'white'])
            } else {
                console.log(message[colors[type] || 'white'], detail)
            }
        }
    }
}

module.exports = ModulatorMaster
