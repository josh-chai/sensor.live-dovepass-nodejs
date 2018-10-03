'struct'

module.exports = {
    PLUGINS: [
        'ModbusRTU',
        'ModbusTCP'
    ],
    STORAGE_PATH: `${__dirname}/../storages`,
    MASTER_COMMAND: {
        START_CONNECTION: 'start_connection',
        SHADOW_DESIRED: 'shadow_desired',
        TERMINATE: 'terminate'
    },
    WORKER_COMMAND: {
        TERMINATED: 'terminated'
    },
    JOB_OPERATION: {
        UPDATE_CONNECTION: 'UpdateConnection',
        DELETE_CONNECTION: 'DeleteConnection',
        SET_SCHEDULE: 'SetSchedule',
        DELETE_SCHEDULE: 'DeleteSchedule',
        SET_RULE: 'SetRule',
        DELETE_RULE: 'DeleteRule'
    }
}
