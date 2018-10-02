module.exports = {
    rtu: {
        '0x01': 'readCoils',
        '0x02': 'readDiscreteInputs',
        '0x03': 'readHoldingRegisters',
        '0x04': 'readInputRegisters',
        '0x05': 'writeCoil',
        '0x06': 'writeRegister',
        '0x0F': 'writeCoils',
        '0x10': 'writeRegisters'
    },
    tcp: {
        '0x01': 'readCoils',
        '0x02': 'readDiscreteInputs',
        '0x03': 'readHoldingRegisters',
        '0x04': 'readInputRegisters',
        '0x05': 'writeSingleCoil',
        '0x06': 'writeSingleRegister',
        '0x0F': 'writeMultipleCoils',
        '0x10': 'writeMultipleRegisters'
    }
}
