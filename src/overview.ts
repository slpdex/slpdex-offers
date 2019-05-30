import { Map, List, Set } from 'immutable'
import * as Immutable from 'immutable'
import { Base64 } from 'js-base64'
import { LOKAD_ID_BASE64, VERSION, decodePrice } from './base';
import { defaultNetworkSettings } from './network';

interface TokenDetails {
    decimals: number
    timestamp: string
    timestampUnix: number
    versionType: number
    documentUri: string
    symbol: string
    name: string
    containsBaton: boolean
    id: string
    documentHash: string | null
    initialTokenQty: number
    blockCreated: number
    blockLastActiveSend: number | null
    blockLastActiveMint: number | null
    txnsSinceGenesis: number
    validAddresses: number
    totalMinted: number
    totalBurned: number
    circulatingSupply: number
    mintingBatonStatus: "NEVER_CREATED" | "ALIVE" | "DEAD_BURNED" | "DEAD_ENDED"
}

interface TokenTotalEntry {
    _id: string
    numberOfOpenOffers: number
    numberOfClosedOffers: number
    lastTrade: {
        timestamp: number
        power: string
        price: string
        isAccepted: boolean
    }
    decimals: number
}

interface TokenVolumeEntry {
    _id: string
    volumeTokens: string
    volumeSatoshis: number
    numberOfTrades: number
    decimals: number
}

interface TokenPriceEntry {
    _id: string
    price: string
    power: string
    decimals: number
}

interface TokenTotal {
    numberOfOpenOffers: number
    numberOfClosedOffers: number
    lastTrade: {
        timestamp: number | undefined
        pricePerToken: number
        isAccepted: boolean
    }
}

interface TokenVolume {
    last24h: {
        volumeTokens: number
        volumeSatoshis: number
        numberOfTrades: number
    }
}

interface TokenPrice {
    last24h: {
        pricePerToken: number
    }
}

interface TokenPriceIncrease {
    last24h: {
        priceIncrease: number | undefined
    }
}

export interface TokenOverview {
    tokenId: string
    totalNumberOfOpenOffers: number
    totalNumberOfClosedOffers: number
    totalSupplyToken: number
    marketCapSatoshis: number | undefined
    lastTrade: {
        timestamp: number | undefined
        pricePerToken: number | undefined
        isAccepted: boolean | undefined
    }
    last24h: {
        volumeTokens: number
        volumeSatoshis: number
        numberOfTrades: number
        pricePerToken: number | undefined
        priceIncrease: number | undefined
    }
}

export type TokenSortByKey = 'totalNumberOfOpenOffers'
                           | 'totalNumberOfClosedOffers'
                           | 'pricePerToken'
                           | 'marketCapSatoshis'
                           | 'volumeTokens'
                           | 'volumeSatoshis'
                           | 'priceIncrease'

export class MarketOverview {
    private _tokenDetails: Map<string, TokenDetails> = Map()
    private _tokenLastTrades: Map<string, TokenTotal> = Map()
    private _tokenVolumes: Map<string, TokenVolume> = Map()
    private _tokenPrices: Map<string, TokenPrice> = Map()
    private _tokenPriceIncreases: Map<string, TokenPriceIncrease> = Map()
    private _tokenOverview: Map<string, TokenOverview> = Map()

    private constructor() {
    }

    public static async create(): Promise<MarketOverview> {
        const tokens = new MarketOverview()
        const promises = [
            tokens._fetchDetails(),
            tokens._fetchTokens(),
            tokens._fetchPrice24h(),
            tokens._fetchVolume24h(),
        ]
        for (const promise of promises)
            await promise
        tokens._updatePriceIncrease()
        tokens._updateOverview()
        return tokens
    }

    private async _fetchDetails() {
        const response = await fetch("https://rest.bitcoin.com/v2/slp/list")
        const tokensJson: TokenDetails[] = await response.json()
        this._tokenDetails = Map(
            tokensJson.map(details => [
                details.id,
                details,
            ])
        )
    }

    private async _fetchTokens() {
        const query = {
            "v": 3,
            "q": {
                "db": ["c", "u"],
                "aggregate": [
                    {"$match":{
                        "in.b0": LOKAD_ID_BASE64,
                        "in.b1": VERSION,
                        "slp.valid": true,
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
                    {"$addFields": {
                        "exchInput": {
                            "$arrayElemAt": [
                                {"$filter": {
                                    "input": "$in",
                                    "as": "input",
                                    "cond": {
                                        "$and": [
                                            {"$eq": ["$$input.b0", LOKAD_ID_BASE64]},
                                            {"$eq": ["$$input.b1", VERSION]},
                                        ],
                                    },
                                }},
                                0,
                            ],
                        },
                        "hasUtxo": {
                            "$size": "$foundUtxo",
                        },
                    }},
                    {"$sort": {
                        "hasUtxo": -1,
                        "blk.t": -1,
                    }},
                    {"$group": {
                        "_id": "$slp.detail.tokenIdHex",
                        "decimals": {"$first": "$slp.detail.decimals"},
                        "numberOfOpenOffers": {"$sum": "$hasUtxo"},
                        "numberOfClosedOffers": {"$sum": {"$subtract": [1, "$hasUtxo"]}},
                        "lastTrade": {"$first": {
                            "timestamp": "$blk.t",
                            "power": "$exchInput.b2",
                            "price": "$exchInput.b3",
                            "isAccepted": {"$ne": ["$foundUtxo", []]},
                        }},
                    }},
                ],
            },
        }
        const queryBase64 = Base64.encode(JSON.stringify(query))
        const response = await fetch("https://slpdb.fountainhead.cash/q/" + queryBase64)
        const tokensJson: {u: TokenTotalEntry[], c: TokenTotalEntry[]} = await response.json()
        const tokenEntriesList = List.of(tokensJson.u, tokensJson.c)
        this._tokenLastTrades = tokenEntriesList
            .map(
                tokenEntries => Map(tokenEntries.map(entry => [
                    entry._id,
                    {
                        numberOfOpenOffers: entry.numberOfOpenOffers,
                        numberOfClosedOffers: entry.numberOfClosedOffers,
                        lastTrade: {
                            pricePerToken: decodePrice(entry.decimals, entry.lastTrade).pricePerToken,
                            timestamp: entry.lastTrade.timestamp,
                            isAccepted: entry.lastTrade.isAccepted,
                        },
                    },
                ]))
            )
            .reduce(
                (a, b) => Map(
                    Set(a.keySeq().concat(b.keySeq()))
                        .map(key => {
                            const itemA = a.get(key)
                            const itemB = b.get(key)
                            let item = itemA || itemB
                            if (itemA !== undefined && itemB !== undefined)
                                item = {
                                    numberOfClosedOffers: itemA.numberOfClosedOffers + itemB.numberOfClosedOffers,
                                    numberOfOpenOffers: itemA.numberOfOpenOffers + itemB.numberOfOpenOffers,
                                    lastTrade: itemA.lastTrade.timestamp === undefined ? itemA.lastTrade : itemB.lastTrade,
                                }
                            if (item === undefined) throw "Impossible"
                            return [key, item]
                        })
                )
            )
    }

    private async _fetchVolume24h() {
        const query = {
            "v": 3,
            "q": {
                "db": ["c", "u"],
                "aggregate": [
                    {"$match": {
                        "in.b0": LOKAD_ID_BASE64,
                        "in.b1": VERSION,
                        "out.e.a": defaultNetworkSettings.feeAddressSlp,
                        "slp.valid": true,
                        "$and": [
                            {"$or": [
                                {"slp.detail.outputs": {"$size": 2}},
                                {"slp.detail.outputs": {"$size": 3}},
                            ]},
                            {"$or": [
                                {"blk": {"$exists": false}},
                                {"blk.t": {"$gt": (new Date().getTime() / 1000) - 24 * 3600}},
                            ]},
                        ],
                    }},
                    {"$addFields": {
                        "tradedTokens": {"$arrayElemAt": ["$slp.detail.outputs", -1]},
                        "tradedSatoshis": {"$arrayElemAt": ["$out", {"$subtract": [{"$size": "$slp.detail.outputs"}, 1]}]},
                    }},
                    {"$project": {
                        "txid": "$tx.h",
                        "tokenId": "$slp.detail.tokenIdHex",
                        "tradedTokens": {"$toDecimal": "$tradedTokens.amount"},
                        "tradedSatoshis": "$tradedSatoshis.e.v",
                        "slp": "$slp",
                    }},
                    {"$group": {
                        "_id": "$tokenId",
                        "volumeTokens": { "$sum": "$tradedTokens" },
                        "volumeSatoshis": { "$sum": "$tradedSatoshis" },
                        "numberOfTrades": { "$sum": 1 },
                        "decimals": {"$first": "$slp.detail.decimals"},
                    }},
                ],
            },
        }
        const queryBase64 = Base64.encode(JSON.stringify(query))
        const response = await fetch("https://slpdb.fountainhead.cash/q/" + queryBase64)
        const tokensJson: {u: TokenVolumeEntry[], c: TokenVolumeEntry[]} = await response.json()
        const tokenEntriesList = List.of(tokensJson.u, tokensJson.c)
        this._tokenVolumes = tokenEntriesList
            .map(
                tokenEntries => Map(tokenEntries.map(entry => [
                    entry._id,
                    {
                        last24h: {
                            numberOfTrades: entry.numberOfTrades,
                            volumeSatoshis: entry.volumeSatoshis,
                            volumeTokens: parseFloat(entry.volumeTokens),
                        }
                    },
                ]))
            )
            .reduce(
                (a, b) => Map(
                    Set(a.keySeq().concat(b.keySeq()))
                        .map(key => {
                            const itemA = a.get(key)
                            const itemB = b.get(key)
                            let item = itemA || itemB
                            if (itemA !== undefined && itemB !== undefined)
                                item = {
                                    last24h: {
                                        numberOfTrades: itemA.last24h.numberOfTrades + itemB.last24h.numberOfTrades,
                                        volumeTokens: itemA.last24h.volumeTokens + itemB.last24h.volumeTokens,
                                        volumeSatoshis: itemA.last24h.volumeSatoshis + itemB.last24h.volumeSatoshis,
                                    }
                                }
                            if (item === undefined) throw "Impossible"
                            return [key, item]
                        })
                )
            )
    }

    private async _fetchPrice24h() {
        const query = {
            "v": 3,
            "q": {
                "db": ["c", "u"],
                "aggregate": [
                    {"$match": {
                        "in.b0": LOKAD_ID_BASE64,
                        "in.b1": VERSION,
                        "out.e.a": defaultNetworkSettings.feeAddressSlp,
                        "slp.valid": true,
                        "$or": [
                            {"slp.detail.outputs": {"$size": 2}},
                            {"slp.detail.outputs": {"$size": 3}},
                        ],
                        "blk.t": {"$lt": (new Date().getTime() / 1000) - 24 * 3600},
                    }},
                    {"$sort": {
                        "blk.t": -1
                    }},
                    {"$unwind": "$in"},
                    {"$match": {
                        "in.b0": LOKAD_ID_BASE64,
                        "in.b1": VERSION,
                    }},
                    {"$group": {
                        "_id": "$slp.detail.tokenIdHex",
                        "price": {"$first": "$in.b3"},
                        "power": {"$first": "$in.b2"},
                        "decimals": {"$first": "$slp.detail.decimals"},
                    }},
                ],
            },
        }
        const queryBase64 = Base64.encode(JSON.stringify(query))
        const response = await fetch("https://slpdb.fountainhead.cash/q/" + queryBase64)
        const tokensJson: {c: TokenPriceEntry[]} = await response.json()
        this._tokenPrices = Map(tokensJson.c.map(entry => [
            entry._id,
            {
                last24h: {
                    pricePerToken: decodePrice(entry.decimals, entry).pricePerToken,
                }
            },
        ]))
    }

    private _updatePriceIncrease() {
        this._tokenPriceIncreases = Map(
            Set(this._tokenLastTrades.keySeq().concat(this._tokenPrices.keySeq()))
                .map(key => {
                    const lastTrade = this._tokenLastTrades.get(key)
                    const ago24h = this._tokenPrices.get(key)
                    return [
                        key,
                        lastTrade !== undefined && ago24h !== undefined ?
                            {last24h: {
                                priceIncrease: (lastTrade.lastTrade.pricePerToken / ago24h.last24h.pricePerToken) - 1.0,
                            }} :
                            {last24h: {
                                priceIncrease: ago24h !== undefined ? 0 : undefined,
                            }}
                    ]
                })
        )
    }

    private _updateOverview() {
        this._tokenOverview = Map(
            this._tokenDetails.entrySeq().map(([key, details]) => {
                const lastTrade = this._tokenLastTrades.get(key)
                const tokenVolumes = this._tokenVolumes.get(key)
                const tokenPrices = this._tokenPrices.get(key)
                const tokenPriceIncreases = this._tokenPriceIncreases.get(key)
                const overview: TokenOverview = {
                    tokenId: key,
                    totalNumberOfOpenOffers: lastTrade ? lastTrade.numberOfOpenOffers : 0,
                    totalNumberOfClosedOffers: lastTrade ? lastTrade.numberOfClosedOffers : 0,
                    totalSupplyToken: details.circulatingSupply,
                    marketCapSatoshis: lastTrade ? lastTrade.lastTrade.pricePerToken * details.circulatingSupply : undefined,
                    lastTrade: {
                        isAccepted: lastTrade ? lastTrade.lastTrade.isAccepted : undefined,
                        pricePerToken: lastTrade ? lastTrade.lastTrade.pricePerToken : undefined,
                        timestamp: lastTrade ? lastTrade.lastTrade.timestamp : undefined,
                    },
                    last24h: {
                        numberOfTrades: tokenVolumes ? tokenVolumes.last24h.numberOfTrades : 0,
                        volumeSatoshis: tokenVolumes ? tokenVolumes.last24h.volumeSatoshis : 0,
                        volumeTokens: tokenVolumes ? tokenVolumes.last24h.volumeTokens : 0,
                        pricePerToken: tokenPrices ? tokenPrices.last24h.pricePerToken : undefined,
                        priceIncrease: tokenPriceIncreases ? tokenPriceIncreases.last24h.priceIncrease : undefined,
                    },
                }
                return [key, overview]
            })
        )
    }

    public tokens(sortByKey: TokenSortByKey, skip: number, limit: number): List<TokenOverview> {
        let sorter: (overview: TokenOverview) => any
        switch (sortByKey) {
            case 'totalNumberOfOpenOffers':
                sorter = (overview) => overview.totalNumberOfOpenOffers
                break
            case 'totalNumberOfClosedOffers':
                sorter = (overview) => overview.totalNumberOfClosedOffers
                break
            case 'pricePerToken':
                sorter = (overview) => overview.lastTrade.pricePerToken
                break
            case 'marketCapSatoshis':
                sorter = (overview) => overview.marketCapSatoshis
                break
            case 'volumeTokens':
                sorter = (overview) => overview.last24h.volumeTokens
                break
            case 'volumeSatoshis':
                sorter = (overview) => overview.last24h.volumeSatoshis
                break
            case 'priceIncrease':
                sorter = (overview) => overview.last24h.priceIncrease
                break
            default:
                throw 'Unknown sort key: ' + sortByKey
        }
        return this._tokenOverview.valueSeq()
            .sortBy(sorter)
            .skip(skip)
            .take(limit)
            .toList()
    }
}
