declare module 'cashaddrjs' {
    export function encode(prefix: string, type: string, hash: Uint8Array): string
    export function decode(addr: string): { prefix: string, type: string, hash: Uint8Array }
}
