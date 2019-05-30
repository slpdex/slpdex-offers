export interface NetworkSettings {
    feeAddress: string
    feeAddressSlp: string
    feeDivisor: number
}

export const defaultNetworkSettings: NetworkSettings = {
    feeAddress: 'bitcoincash:qp5x5tmxluwm62ny66zy9u4zuqvkmcv8sq2ceuxmwd',
    feeAddressSlp: 'simpleledger:qp5x5tmxluwm62ny66zy9u4zuqvkmcv8sqxrj8nmsn',
    //'bitcoincash:qzjh2vj5h947cw57slye72gta3uw7esupgzhz96suz',
    feeDivisor: 500,
}
