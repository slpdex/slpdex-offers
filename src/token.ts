import { List } from 'immutable'
import { Base64 } from 'js-base64'
import { LOKAD_ID_BASE64, VERSION, decodePrice, decodeAddress } from './base'
import * as cashcontracts from 'cashcontracts'
import { NetworkSettings } from './network'
import BigNumber from 'bignumber.js'

export interface TokenOffer {
    timestamp: number | undefined
    utxoEntry: {
        txid: string
        vout: number
        satoshis: BigNumber
    }
    pricePerToken: BigNumber
    scriptPrice: BigNumber
    sellAmountToken: BigNumber
    receivingAddress: string
}

interface TokenOfferEntry {
    blk?: {t: number}
    tx: {h: string}
    in: {
        b0?: string
        b1?: string | {op: number}
        b2?: string
        b3?: string
        b4?: string
        b5?: string
        e: {
            h: string
            i: number
        }
    }[]
    out: {
        e: {
            a: string
            v: number
        }
    }[]
    slp: {
        detail: {
            tokenIdHex: string
            decimals: number
            outputs: {address: string, amount: string}[]
        }
    }
}

export class MarketToken {
    public static debug = false

    private _tokenId: string | undefined
    private _offers: List<TokenOffer> = List()
    private _networkSettings: NetworkSettings
    private _receivedOfferListeners: (() => void)[] = []

    private constructor(tokenId: string | undefined, networkSettings: NetworkSettings) {
        this._tokenId = tokenId
        this._networkSettings = networkSettings
        this._listenForOffers()
        this._listenForCancels()
    }

    public static async create(tokenId: string | undefined, networtkSettings: NetworkSettings): Promise<MarketToken> {
        await cashcontracts.ready
        const tokens = new MarketToken(tokenId, networtkSettings)
        await tokens._fetchOffers()
        return tokens
    }

    private _listenForOffers() {
        const query = {
            "v": 3,
            "q": {
                "find": {
                    "in.b0": LOKAD_ID_BASE64,
                    "in.b1": VERSION,
                    "slp.valid": true,
                    "slp.detail.tokenIdHex": this._tokenId,
                },
            },
        }
        const queryBase64 = Base64.encode(JSON.stringify(query))
        const source = new EventSource("https://slpsocket.fountainhead.cash/s/" + queryBase64)
        source.onmessage = (msg) => this._receivedTx(msg)
    }

    private _listenForCancels() {
        const query = {
            "v": 3,
            "q": {
                "find": {
                    "in.b0": {"$ne": LOKAD_ID_BASE64},
                    "in.b1": {"$ne": VERSION},
                    "in.b2": {op: 0},
                    "slp.valid": true,
                    "slp.detail.tokenIdHex": this._tokenId,
                },
            },
        }
        const queryBase64 = Base64.encode(JSON.stringify(query))
        const source = new EventSource("https://slpsocket.fountainhead.cash/s/" + queryBase64)
        source.onmessage = (msg) => this._receivedTx(msg)
    }

    private _receivedTx(msg: MessageEvent) {
        const resp: {data: TokenOfferEntry[], type: string} = JSON.parse(msg.data)
        if (MarketToken.debug)
            console.log(msg)
        if (resp.type != 'mempool') return
        for (const entry of resp.data) {
            this._offers = this._offers.filter(
                offer => entry.in.findIndex(input => offer.utxoEntry.txid == input.e.h && offer.utxoEntry.vout == input.e.i) == -1 
            )
            const exchInput = this._findExchInput(entry)
            if (exchInput === undefined) continue
            const offer = this._transformTx(entry)
            if (offer === undefined) continue
            this._offers = this._offers.push(offer)
        }
        this._offers = this._offers.sortBy(offer => offer.pricePerToken)
        this._receivedOfferListeners.forEach(listener => listener())
    }

    private async _fetchOffers() {
        const query = {
            "v": 3,
            "q": {
                "db": ["c", "u"],
                "aggregate": [
                    {"$match":{
                        "in.b0": LOKAD_ID_BASE64,
                        "in.b1": VERSION,
                        "slp.valid": true,
                        "slp.detail.tokenIdHex": this._tokenId,
                    }},
                    {"$addFields": {
                        "utxoId": {"$concat": ["$tx.h", ":1"]},  // smart contract is at vout=1
                    }},
                    {"$lookup": {
                        "from": "utxos",
                        "localField": "utxoId",
                        "foreignField": "utxo",
                        "as": "foundUtxo",
                    }},
                    {"$match": {
                        "foundUtxo": {"$ne": []},
                    }},
                ],
            },
        }
        const queryBase64 = Base64.encode(JSON.stringify(query))
        const response = await fetch("https://slpdb.fountainhead.cash/q/" + queryBase64)
        const tokensJson: {c: TokenOfferEntry[], u: TokenOfferEntry[]} = await response.json()
        const offerEntries = tokensJson.u.concat(tokensJson.c)
        this._offers = List(offerEntries).flatMap<TokenOffer>(entry => {
            const offer = this._transformTx(entry)
            if (offer === undefined)
                return List.of()
            return List.of(offer)
        }).sortBy(offer => offer.pricePerToken.toNumber())
    }

    private _findExchInput(entry: TokenOfferEntry) {
        const exchInputs = entry.in.filter(
            input => input.b0 == LOKAD_ID_BASE64 && 
                        typeof input.b1 == 'object' &&
                        input.b1.op == VERSION.op
        )
        if (exchInputs.length == 0)
            return undefined
        return exchInputs[0]
    }

    private _transformTx(entry: TokenOfferEntry): TokenOffer | undefined {
        const tokenFactor = new BigNumber('10').pow(entry.slp.detail.decimals)
        const exchInput = this._findExchInput(entry)
        if (exchInput === undefined)
            return undefined
        if (!exchInput.b2 || !exchInput.b3 || !exchInput.b4)
            return undefined
        try {
            const utxo = {
                bchSatoshis: entry.out[1].e.v,
                address: entry.out[1].e.a,
                slpAmount: entry.slp.detail.outputs[0].amount,
            }
            const price = decodePrice(
                entry.slp.detail.decimals,
                {power: exchInput.b2, price: exchInput.b3},
            );
            const offer = {
                timestamp: entry.blk && entry.blk.t,
                utxoEntry: {
                    txid: entry.tx.h,
                    vout: 1,
                    satoshis: new BigNumber(utxo.bchSatoshis),
                    address: utxo.address,
                },
                pricePerToken: price.pricePerToken,
                scriptPrice: price.scriptPrice,
                sellAmountToken: new BigNumber(utxo.slpAmount),
                receivingAddress: decodeAddress(exchInput.b4),
                expectedAddress: '',
            }
            offer.expectedAddress = cashcontracts.advancedTradeOfferAddress(tokenFactor, {
                tokenId: entry.slp.detail.tokenIdHex,
                sellAmountToken: offer.sellAmountToken,
                pricePerToken: offer.pricePerToken,
                receivingAddress: offer.receivingAddress,
                feeAddress: this._networkSettings.feeAddress,
                feeDivisor: new BigNumber(this._networkSettings.feeDivisor),
            })
            if (offer.expectedAddress != offer.utxoEntry.address) {
                return undefined
            }
            return offer
        } catch (e) {
            return undefined
        }
    }

    public offers(): List<TokenOffer> {
        return this._offers
    }

    public tokenId(): string | undefined {
        return this._tokenId
    }

    public addReceivedOfferListener(listener: () => void) {
        this._receivedOfferListeners.push(listener)
    }
}
