'strict'

const cluster = require('cluster')
const fs = require('fs')
const aws_iot = require('aws-iot-device-sdk')
const thing_registry = require('sensor.live-things-registry')
const SerialPort = require('serialport')
const CronJob = require('cron').CronJob

const {
    PLUGINS,
    STORAGE_PATH,
    MASTER_COMMAND,
    WORKER_COMMAND,
    JOB_OPERATION
} = require('./ModulatorConstant')

require('colors')

const config = {
    aws_iot: {
        endpoint: 'axt811sti1q4w.iot.ap-northeast-1.amazonaws.com',
        port: '8883',
        debug: false
    }
}

const test_thing_name = 'RP1'

class ModulatorMaster {
    constructor() {
        this.jobs = null
        this.thing_shadow = null
        this.update_thing_shadow_queue = []
        this.shadow_datasets = {}
        this.schedule = null
        this.rule = null
        this.timer = null
        this.thing_name = 'auto'
        this.keys_path = {}
    }
    async initialize() {
        this.thing_name = test_thing_name
        await this.initIotCertificate(this.thing_name).then(({ thing_name, keys_path }) => {
            this.thing_name = thing_name
            this.keys_path = keys_path
            console.log('AWS IoT certificates is ready.'.green)
        }, error => {
            console.log(`${error}`.red)
        })
        await this.initThingShadowClient(this.thing_name, this.keys_path).then((thing_shadow) => {
            this.thing_shadow = thing_shadow
            this.registerThingShadowEvent()
            this.processShadowQueue()
            console.log('AWS IoT has connected'.green)
        }, error => {
            console.log('Shadow error'.red, error)
            process.exit()
        })
        await this.$worker().loadFiles().then(connections => {
            for (let connection of connections) {
                console.log(`Loaded config file[${connection.file}]`.magenta)
                this.$worker().start(connection.config)
            }
        }, error => {
            console.log('Connection file invalid'.red, error)
            process.exit()
        })
        await this.$schedule().loadFiles().then(schedules => {
            for (let index in schedules) {
                let schedule = schedules[index]
                console.log(`Loaded config file[${schedule.file}]`.magenta)
                this.$schedule().start(schedule.config).then(started => {
                    if (parseInt(index) + 1 === schedules.length) {
                        this.$schedule().report()
                    }
                })
            }
        }, error => {
            console.log('Schedule file invalid'.red, error)
        })
        await this.$rule().loadFiles().then(rules => {
            for (let rule of rules) {
                console.log(`Loaded config file[${rule.file}]`.magenta)
                this.$rule().add(rule.config)
            }
            this.$rule().report()
        }, error => {
            console.log('Rule file valid'.red, error)
        })
        await this.initJobsClient(this.thing_name).then((jobs) => {
            this.jobs = jobs
            this.registerJobsEvent()
            console.log('Jobs has connected'.green)
        })
        await this.processDatasets()
        await this.processRules()
    }
    initIotCertificate(thing_name) {
        return new Promise((resolve, reject) => {
            try {
                thing_registry.setCertsPath('./certs')
                if (!thing_registry.hasDeviceCertificate()) {
                    thing_registry.generateDeviceCertificate({
                        thing_name
                    })
                }
                resolve({
                    thing_name: thing_registry.getThingName(),
                    keys_path: thing_registry.getKeysPath()
                })
            } catch (exception) {
                reject(exception)
            }
        })
    }
    initThingShadowClient(thing_name, keys_path) {
        return new Promise((resolve, reject) => {
            const thing_shadow = aws_iot.thingShadow({
                ...keys_path,
                host: config.aws_iot.endpoint,
                port: config.aws_iot.port,
                debug: config.aws_iot.debug,
                clientId: `shadow-${thing_name}`
            })
            thing_shadow.on('connect', () => {
                resolve(thing_shadow)
            })
            thing_shadow.on('error', (error) => {
                reject(error)
            })
        })
    }
    initJobsClient() {
        return new Promise((resolve, reject) => {
            const jobs = aws_iot.jobs({
                ...this.keys_path,
                host: config.aws_iot.endpoint,
                port: config.aws_iot.port,
                debug: config.aws_iot.debug,
                clientId: `job-${this.thing_name}`
            })
            jobs.on('connect', () => {
                resolve(jobs)
            })
            jobs.on('error', (error) => {
                reject(error)
            })
        })
    }
    registerJobsEvent() {
        this.jobs.subscribeToJobs(this.thing_name, async(error, job) => {
            if (error) {
                console.log('Subscribe job error'.red, error)
            } else {
                let document = job.document || {}
                let operation = document.operation
                let config = document.config || {}
                await job.inProgress({
                    operation: operation,
                    step: 'Received jobs'
                }, (error) => {
                    if (error) {
                        console.log(`Operation: ${operation} in progress error \n ${error}`.red)
                    }
                })
                if ([JOB_OPERATION.UPDATE_CONNECTION, JOB_OPERATION.DELETE_CONNECTION].indexOf(operation) > -1) {
                    this.$worker().processJob(job, operation, config)
                } else if ([JOB_OPERATION.SET_SCHEDULE, JOB_OPERATION.DELETE_SCHEDULE].indexOf(operation) > -1) {
                    this.$schedule().processJob(job, operation, config)
                } else if ([JOB_OPERATION.SET_RULE, JOB_OPERATION.DELETE_RULE].indexOf(operation) > -1) {
                    this.$rule().processJob(job, operation, config)
                } else {
                    console.log(`Unknow job: ${operation}`)
                }
            }
        })
        this.jobs.startJobNotifications(this.thing_name, (error) => {
            if (error) {
                console.log('start job notifications error: '.red, error)
            } else {
                console.log(`Job notifications initiated for thing: ${this.thing_name}`.green)
            }
        })
        this.jobs.on('close', () => {
            console.log('Jobs has closed'.gray)
        })
        this.jobs.on('reconnect', () => {
            console.log('Jobs will reconnect'.gray)
        })
        this.jobs.on('offline', () => {
            console.log('Jobs has offline'.gray)
        })
        this.jobs.on('error', (error) => {
            console.log('Jobs error: ', error)
        })
    }
    registerThingShadowEvent() {
        this.thing_shadow.register(this.thing_name, (error) => {
            if (error) {
                console.log('Shadow has unregistered'.red)
            } else {
                console.log('Shadow has registered'.green)
            }
        })
        this.thing_shadow.subscribe(`@dovepass/things/${this.thing_name}/info/get`)
        this.thing_shadow.on('message', (topic, message) => {
            if (topic.match(/^@dovepass\/things\/.*\/info\/get$/)) {
                let payload = JSON.parse(message.toString())
                for (let field of (payload.fields || [])) {
                    let method = 'report' + field.replace(/[-_]/g, ' ').replace(/^([a-z])|\s+([a-z])/g, ($1) => {
                        return $1.toUpperCase()
                    }).replace(/\x20/g, '')
                    if (typeof this.$info()[method] === 'function') {
                        this.$info()[method]()
                    }
                }
            }
        })
        this.thing_shadow.on('delta', (thing_name, document) => {
            this.executeDesired(document.state, false)
        })
    }
    $worker() {
        let parent = this
        return {
            start(connection) {
                return new Promise((resolve, reject) => {
                    try {
                        let worker = cluster.fork()
                        worker.on('online', () => {
                            this._onlineHandler(worker, connection)
                        })
                        worker.on('message', (message) => {
                            this._messageHandler(worker, connection, message)
                        })
                        worker.on('disconnect', () => {
                            this._disconnectHandler(worker)
                        })
                        resolve(worker)
                    } catch (exception) {
                        reject(exception)
                    }
                })
            },
            stop(connection) {
                return new Promise((resolve, reject) => {
                    try {
                        let current_worker = null
                        for (let id in cluster.workers) {
                            if (cluster.workers[id].name === connection.name) {
                                current_worker = cluster.workers[id]
                            }
                        }
                        if (current_worker) {
                            current_worker.send({
                                command: MASTER_COMMAND.TERMINATE
                            })
                        }
                        resolve(current_worker)
                    } catch (exception) {
                        reject(exception)
                    }
                })
            },
            restart(connection) {
                return new Promise((resolve, reject) => {
                    this.stop(connection).then(worker => {
                        setTimeout(() => {
                            this.start(connection).then(worker => {
                                resolve(worker)
                            }, error => {
                                reject(error)
                            })
                        }, 3000)
                    }, error => {
                        reject(error)
                    })
                })
            },
            loadFiles() {
                return new Promise((resolve, reject) => {
                    let connections = []
                    try {
                        fs.readdirSync(STORAGE_PATH).forEach(file => {
                            if (file.match(/^(ModbusTCP|ModbusRTU)-(.*)\.json/)) {
                                connections.push({
                                    file,
                                    config: require(`${STORAGE_PATH}/${file}`)
                                })
                            }
                        })
                        resolve(connections)
                    } catch (exception) {
                        reject(exception)
                    }
                })
            },
            validate(connection) {
                return PLUGINS.indexOf(connection.type) > -1 && connection.name !== ''
            },
            link(connection) {
                let file = this._filename(connection)
                try {
                    fs.writeFileSync(file, JSON.stringify(connection, null, 4))
                } catch (exception) {
                    console.log('Can\'t write connection file'.red, exception)
                }
                return this
            },
            unlink(connection) {
                let file = this._filename(connection)
                try {
                    if (fs.existsSync(file)) {
                        fs.unlinkSync(file)
                    }
                } catch (exception) {
                    console.log('Can\'t delete connection file'.red, exception)
                }
                return this
            },
            _filename(connection) {
                return `${STORAGE_PATH}/${connection.type}-${connection.name}.json`
            },
            _onlineHandler(worker, config) {
                worker.name = config.name
                worker.shadow_report_rate = config.shadow_report_rate
                worker.send({
                    command: MASTER_COMMAND.START_CONNECTION,
                    data: config
                })
                console.log(`Worker[${worker.name}]{${worker.id}} start running.`.green)
            },
            _messageHandler(worker, config, message) {
                switch (message.command) {
                    case 'shadowReported':// refactory constant
                        parent.$dataset()
                            .shadowReported(worker.name)
                            .store(message.payload)
                        break
                    case 'shadowClearDelta':// refactory constant
                        let desired = {}
                        for (let property in message.payload) {
                            desired[property] = null
                        }
                        parent.updateThingShadow({
                            state: {
                                reported: message.payload || {},
                                desired
                            }
                        })
                        break
                    case WORKER_COMMAND.TERMINATED:
                        worker.kill()
                        break
                }
                // console.log(`Worker[${worker.name}]{${worker.id}} sent message.`.red)
            },
            _disconnectHandler(worker) {
                parent.$dataset()
                    .shadowReported(worker.name)
                    .destroy()
                parent.$timer(worker.name)
                    .shadowReported()
                    .clearInterval()
                console.log(`Worker[${worker.name}]{${worker.id}} stopped.`.red)
            },
            processJob(job, operation, config) {
                if (!this.validate(config)) {
                    job.rejected({
                        operation,
                        step: 'Connection config valid'
                    }, (error) => {
                        if (error) {
                            console.log(`Operation: ${operation} update rejected error \n ${error}`.red)
                        }
                    })
                }
                if (operation === JOB_OPERATION.UPDATE_CONNECTION) {
                    this.link(config).restart(config).then(worker => {
                        job.succeeded({
                            operation,
                            step: 'Update success'
                        }, (error) => {
                            if (error) {
                                console.log(`Operation: ${operation} update successed error \n ${error}`.red)
                            }
                        })
                    }, error => {
                        job.failed({
                            operation,
                            step: 'Update failed'
                        }, (error) => {
                            if (error) {
                                console.log(`Operation: ${operation} update rejected error \n ${error}`.red)
                            }
                        })
                    })
                } else if (operation === JOB_OPERATION.DELETE_CONNECTION) {
                    console.log('Unprocess: ', operation)
                }
            }
        }
    }
    $schedule() {
        let parent = this
        if (this.schedule) {
            return this.schedule
        }
        return this.schedule = {
            schedules: [],
            start(schedule) {
                return new Promise((resolve, reject) => {
                    try {
                        this.schedules[schedule.id] = new CronJob(schedule.expression, () => {
                            parent.executeDesired(schedule.actions, true)
                        }, null, true, 'UTC')
                        console.log(`Schedule [${schedule.name}] started.`.green)
                        resolve(schedule)
                    } catch (exception) {
                        reject(exception)
                    }
                })
            },
            stop(schedule) {
                return new Promise((resolve, reject) => {
                    try {
                        if (this.schedules[schedule.id]) {
                            this.schedules[schedule.id].stop()
                            delete this.schedules[schedule.id]
                            console.log(`Schedule [${schedule.name}] stoped.`.red)
                        }
                        resolve(schedule)
                    } catch (exception) {
                        reject(exception)
                    }
                })
            },
            restart(schedule) {
                return new Promise((resolve, reject) => {
                    this.stop(schedule).then(stoped => {
                        this.start(schedule).then(started => {
                            resolve(started)
                        }, error => {
                            reject(error)
                        })
                    }, error => {
                        reject(error)
                    })
                })
            },
            report() {
                parent.updateThingShadow({
                    state: {
                        reported: {
                            schedules: Object.keys(this.schedules)
                        }
                    }
                })
            },
            loadFiles() {
                return new Promise((resolve, reject) => {
                    let schedules = []
                    try {
                        fs.readdirSync(STORAGE_PATH).forEach(file => {
                            if (file.match(/^(Schedule)-(.*)\.json/)) {
                                schedules.push({
                                    file,
                                    config: require(`${STORAGE_PATH}/${file}`)
                                })
                            }
                        })
                        resolve(schedules)
                    } catch (exception) {
                        reject(exception)
                    }
                })
            },
            validate(schedule) {
                return schedule.id !== '' && schedule.name !== ''
            },
            link(schedule) {
                let file = this._filename(schedule)
                try {
                    fs.writeFileSync(file, JSON.stringify(schedule, null, 4))
                } catch (exception) {
                    console.log('Can\'t write schedule file'.red, exception)
                }
                return this
            },
            unlink(schedule) {
                let file = this._filename(schedule)
                try {
                    if (fs.existsSync(file)) {
                        fs.unlinkSync(file)
                    }
                } catch (exception) {
                    console.log('Can\'t delete schedule file'.red, exception)
                }
                return this
            },
            _filename(schedule) {
                return `${STORAGE_PATH}/Schedule-${schedule.id}.json`
            },
            processJob(job, operation, config) {
                if (!this.validate(config)) {
                    job.rejected({
                        operation: JOB_OPERATION.SET_SCHEDULE,
                        step: 'Schedule config valid'
                    }, (error) => {
                        if (error) {
                            console.log(`Operation: ${JOB_OPERATION.SET_SCHEDULE} update rejected error \n ${error}`.red)
                        }
                    })
                }
                if (operation === JOB_OPERATION.SET_SCHEDULE) {
                    this.link(config).restart(config).then(worker => {
                        this.report()
                        job.succeeded({
                            operation,
                            step: 'Update success'
                        }, (error) => {
                            if (error) {
                                console.log(`Operation: ${operation} update successed error \n ${error}`.red)
                            }
                        })
                    }, error => {
                        job.failed({
                            operation,
                            step: 'Update failed'
                        }, (error) => {
                            if (error) {
                                console.log(`Operation: ${operation} update rejected error \n ${error}`.red)
                            }
                        })
                    })
                } else if (operation === JOB_OPERATION.DELETE_SCHEDULE) {
                    this.unlink(config).stop(config).then(worker => {
                        this.report()
                        job.succeeded({
                            operation,
                            step: 'Update success'
                        }, (error) => {
                            if (error) {
                                console.log(`Operation: ${operation} update successed error \n ${error}`.red)
                            }
                        })
                    }, error => {
                        job.failed({
                            operation,
                            step: 'Update failed'
                        }, (error) => {
                            if (error) {
                                console.log(`Operation: ${operation} update rejected error \n ${error}`.red)
                            }
                        })
                    })
                }
            }
        }
    }
    $rule() {
        let parent = this
        if (this.rule) {
            return this.rule
        }
        return this.rule = {
            rules: [],
            add(rule) {
                this.rules[rule.id] = rule
                console.log(`Rule [${rule.name}] added.`.green)
            },
            remove(rule) {
                delete this.rules[rule.id]
                console.log(`Rule [${rule.name}] removed.`.red)
            },
            report() {
                parent.updateThingShadow({
                    state: {
                        reported: {
                            rules: Object.keys(this.rules)
                        }
                    }
                })
            },
            loadFiles() {
                return new Promise((resolve, reject) => {
                    let rules = []
                    try {
                        fs.readdirSync(STORAGE_PATH).forEach(file => {
                            if (file.match(/^(Rule)-(.*)\.json/)) {
                                rules.push({
                                    file,
                                    config: require(`${STORAGE_PATH}/${file}`)
                                })
                            }
                        })
                        resolve(rules)
                    } catch (exception) {
                        reject(exception)
                    }
                })
            },
            validate(rule) {
                return rule.id !== '' && rule.name !== ''
            },
            link(rule) {
                let file = this._filename(rule)
                try {
                    fs.writeFileSync(file, JSON.stringify(rule, null, 4))
                } catch (exception) {
                    console.log('Can\'t write rule file'.red, exception)
                }
                return this
            },
            unlink(rule) {
                let file = this._filename(rule)
                try {
                    if (fs.existsSync(file)) {
                        fs.unlinkSync(file)
                    }
                } catch (exception) {
                    console.log('Can\'t delete rule file'.red, exception)
                }
                return this
            },
            _filename(rule) {
                return `${STORAGE_PATH}/Rule-${rule.id}.json`
            },
            processJob(job, operation, config) {
                if (!this.validate(config)) {
                    job.rejected({
                        operation,
                        step: 'Rule config valid'
                    }, (error) => {
                        if (error) {
                            console.log(`Operation: ${operation} update rejected error \n ${error}`.red)
                        }
                    })
                }
                if (operation === JOB_OPERATION.SET_RULE) {
                    this.link(config).add(config)
                    this.report()
                    job.succeeded({
                        operation,
                        step: 'Update success'
                    }, (error) => {
                        if (error) {
                            console.log(`Operation: ${operation} update successed error \n ${error}`.red)
                        }
                    })
                } else if (operation === JOB_OPERATION.DELETE_RULE) {
                    this.unlink(config).remove(config)
                    this.report()
                    job.succeeded({
                        operation,
                        step: 'Delete success'
                    }, (error) => {
                        if (error) {
                            console.log(`Operation: ${operation} delete successed error \n ${error}`.red)
                        }
                    })
                }
                this.report()
            }
        }
    }
    // refactory
    updateThingShadow(state) {
        this.update_thing_shadow_queue.push(state)
    }
    // refactory
    processShadowQueue() {
        setInterval(() => {
            let state = this.update_thing_shadow_queue.shift()
            if (state) {
                let client_token = this.thing_shadow.update(this.thing_name, state)
                if (client_token === null) {
                    console.log('Update shadow failed, operation still in progress'.red)
                } else {
                    console.log('Update shadow success: ', `${JSON.stringify(state)}`.cyan)
                }
            }
        }, 1000)
    }
    // refactory to $dateset()
    processDatasets() {
        return new Promise(resolve => {
            for (let index in cluster.workers) {
                let worker = cluster.workers[index]
                this.$timer(worker.name)
                    .shadowReported()
                    .setInterval(() => {
                        let payload = this.$dataset()
                            .shadowReported(worker.name)
                            .get()
                        if (payload) {
                            this.updateThingShadow({
                                state: {
                                    reported: payload
                                }
                            })
                        }
                    }, (parseInt(worker.shadow_report_rate) || 60) * 1000)
            }
            resolve(true)
        })
    }
    // refactory to $rule()
    processRules() {
        return new Promise(resolve => {
            setInterval(() => {
                this.executeRules()
            }, 1000)
            resolve(true)
        })
    }
    $info() {
        let parent = this
        return {
            reportSerialPort() {
                SerialPort.list().then(ports => {
                    parent.thing_shadow.publish(`@dovepass/things/${parent.thing_name}/info/get/accepted`, JSON.stringify({
                        serial_ports: ports.map(port => {
                            return port.comName
                        })
                    }))
                }, error => {
                    console.log('Can\'t load serial ports', error)
                })
            }
        }
    }
    $dataset() {
        let parent = this
        return {
            shadowReported(name) {
                return {
                    get() {
                        return parent.shadow_datasets[name]
                    },
                    store(dataset) {
                        parent.shadow_datasets[name] = dataset
                    },
                    destroy() {
                        delete parent.shadow_datasets[name]
                    }
                }
            },
            collapse() {
                return {
                    all() {
                        let result = {}
                        for (let name in parent.shadow_datasets) {
                            let datasets = parent.shadow_datasets[name]
                            result = {
                                ...result,
                                ...datasets
                            }
                        }
                        return result
                    }
                }
            }
        }
    }
    $timer(name) {
        let parent = this
        if (this.timer) {
            return this.timer
        }
        return this.timer = {
            timers: [],
            shadowReported() {
                let self = this
                return {
                    setInterval(callback, interval) {
                        self.setInterval(`shadow_report-${name}`, callback, interval)
                    },
                    clearInterval() {
                        self.clearInterval(`shadow_report-${name}`)
                    }
                }
            },
            setInterval(name, callback, interval) {
                this.timers[name] = setInterval(callback, interval)
            },
            clearInterval(name) {
                clearInterval(this.timers[name])
                delete this.timers[name]
            }
        }
    }
    // refactory to $rule()
    executeRules() {
        let payload = this.$dataset().collapse().all()
        let rules = this.$rule().rules
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
    // refactory
    executeDesired(actions, is_local) {
        let state_groups = {}
        let current_worker = null
        for (let property in actions) {
            let name = property.replace(/^([^-]*)-(.*)/, '$1')
            if (!state_groups[name]) {
                state_groups[name] = {}
            }
            state_groups[name][property] = actions[property]
        }
        for (let name in state_groups) {
            let desired_state = state_groups[name]
            for (let id in cluster.workers) {
                if (cluster.workers[id].name === name) {
                    current_worker = cluster.workers[id]
                }
            }
            if (current_worker) {
                current_worker.send({
                    command: MASTER_COMMAND.SHADOW_DESIRED,
                    data: desired_state,
                    is_local
                })
            }
        }
    }
}

module.exports = ModulatorMaster
