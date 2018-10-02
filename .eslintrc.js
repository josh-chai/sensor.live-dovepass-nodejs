module.exports = {
    extends: 'standard',
    rules: {
        indent: 0,
        camelcase: [0, {
            properties: 'never',
            ignoreDestructuring: true
        }],
        'handle-callback-err': [0],
        'space-before-function-paren': ['error', 'never'],
        'prefer-promise-reject-errors': ['error', { 'allowEmptyReject': true }]
    }
}