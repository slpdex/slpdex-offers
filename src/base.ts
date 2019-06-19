import { Base64 } from 'js-base64'
import * as cashaddr from 'cashaddrjs'
import BigNumber from 'bignumber.js';

export const LOKAD_ID_BASE64 = Base64.encode("EXCH")
export const VERSION = {op: 0x52}

function decodeBase64(base64: string): Uint8Array {
    return Uint8Array.from(atob(base64), c => c.charCodeAt(0))
}

export function decodePrice(decimals: number, offer: {power: string, price: string}): {pricePerToken: BigNumber, scriptPrice: BigNumber} {
    const powerBuffer = decodeBase64(offer.power)
    const scriptPriceBuffer = decodeBase64(offer.price)
    const isInverted = powerBuffer.length == 2 && powerBuffer[1] == 1
    const scriptPrice = new BigNumber(new DataView(scriptPriceBuffer.buffer).getUint32(0, false))
    const pricePerBaseToken = isInverted ? new BigNumber('1').div(scriptPrice) : scriptPrice
    const factor = new BigNumber('10').pow(decimals)
    return {pricePerToken: factor.times(pricePerBaseToken), scriptPrice}
}

export function decodeAddress(addressBase64: string): string {
    return cashaddr.encode("bitcoincash", "P2PKH", decodeBase64(addressBase64))
}
