/*! DropDial 1.5.0 · © 2026 Yash Gupta. All rights reserved. https://unknown8575.github.io/DropDial-Releases/ */
var d=Object.defineProperty;var o=(e,t)=>d(e,"name",{value:t,configurable:!0});export function decodeText(e){if(e[0]===255&&e[1]===254)return new TextDecoder("utf-16le").decode(e.subarray(2));if(e[0]===254&&e[1]===255)return new TextDecoder("utf-16be").decode(e.subarray(2));e[0]===239&&e[1]===187&&e[2]===191&&(e=e.subarray(3));try{return new TextDecoder("utf-8",{fatal:!0}).decode(e)}catch{return new TextDecoder("windows-1252").decode(e)}}o(decodeText,"decodeText");export function blocksToText(e){const t=o(r=>Array.isArray(r)?r.map(c=>c.text||"").join(""):"","text"),n=[];let f=0;for(const r of e)if(f=r.type==="li"&&r.ordered?f+1:0,r.type==="h"||r.type==="p")n.push(t(r.runs));else if(r.type==="li")n.push((r.ordered?`${f}. `:"• ")+t(r.runs));else if(r.type==="table")for(const c of r.rows||[])n.push(c.map(s=>String(s).replace(/\s*\n\s*/g," ")).join("	"));return n.join(`
`).replace(/\n{3,}/g,`

`).trim()+`
`}o(blocksToText,"blocksToText");
