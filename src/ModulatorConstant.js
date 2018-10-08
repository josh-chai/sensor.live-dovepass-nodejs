'struct'

module.exports = {
    PLUGINS: [
        'ModbusRTU',
        'ModbusTCP'
    ],
    STORAGE_PATH: `${__dirname}/../storages`,
    MASTER_COMMAND: {
        START_CONNECTION: 'start_connection',
        TERMINATE_CONNECTION: 'terminate_connection',
        SHADOW_DESIRED: 'shadow_desired'
    },
    WORKER_COMMAND: {
        SHADOW_REPORTED: 'shadow_report',
        SHADOW_CLEAR_DELTA: 'shadow_clear_delta',
        TERMINATED: 'terminated'
    },
    JOB_OPERATION: {
        SET_CONNECTION: 'SetConnection',
        DELETE_CONNECTION: 'DeleteConnection',
        SET_SCHEDULE: 'SetSchedule',
        DELETE_SCHEDULE: 'DeleteSchedule',
        SET_RULE: 'SetRule',
        DELETE_RULE: 'DeleteRule'
    }
}
