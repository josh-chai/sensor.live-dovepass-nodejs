'strict'

const fs = require('fs')

const {
    PLUGINS,
    STORAGE_PATH
} = require('./ModulatorConstant')

class Storage {
    getConnectionsConfig() {
        let files = []
        fs.readdirSync(STORAGE_PATH).forEach(file => {
            if (file.match(/^(Connection)-(.*)\.json/)) {
                files.push(file)
            }
        })
        return files
    }
    getSchedulesConfig() {
        let files = []
        fs.readdirSync(STORAGE_PATH).forEach(file => {
            if (file.match(/^(Schedule)-(.*)\.json/)) {
                files.push(file)
            }
        })
        return files
    }
    getRulesConfig() {
        let files = []
        fs.readdirSync(STORAGE_PATH).forEach(file => {
            if (file.match(/^(Rule)-(.*)\.json/)) {
                files.push(file)
            }
        })
        return files
    }
    storeConnectionConfig(config) {
        let file = this._getConnectionFileName(config)
        try {
            fs.writeFileSync(file, JSON.stringify(config, null, 4))
        } catch (exception) {
            console.log('Can\'t write connection file'.red, exception)
        }
        return this
    }
    storeScheduleConfig(config) {
        let file = this._getScheuldeFileName(config)
        try {
            fs.writeFileSync(file, JSON.stringify(config, null, 4))
        } catch (exception) {
            console.log('Can\'t write schedule file'.red, exception)
        }
        return this
    }
    storeRuleConfig(config) {
        let file = this._getRuleFileName(config)
        try {
            fs.writeFileSync(file, JSON.stringify(config, null, 4))
        } catch (exception) {
            console.log('Can\'t write rule file'.red, exception)
        }
        return this
    }
    deleteConnectionConfig(config) {
        let file = this._getConnectionFileName(config)
        try {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file)
            }
        } catch (exception) {
            console.log('Can\'t delete connection file'.red, exception)
        }
        return this
    }
    deleteScheduleConfig(config) {
        let file = this._getScheuldeFileName(config)
        try {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file)
            }
        } catch (exception) {
            console.log('Can\'t delete schedule file'.red, exception)
        }
        return this
    }
    deleteRuleConfig(config) {
        let file = this._getRuleFileName(config)
        try {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file)
            }
        } catch (exception) {
            console.log('Can\'t delete rule file'.red, exception)
        }
        return this
    }
    _getConnectionFileName(config) {
        return `${STORAGE_PATH}/Connection-${config.id}.json`
    }
    _getScheuldeFileName(config) {
        return `${STORAGE_PATH}/Schedule-${config.id}.json`
    }
    _getRuleFileName(config) {
        return `${STORAGE_PATH}/Rule-${config.id}.json`
    }
}

module.exports = Storage
