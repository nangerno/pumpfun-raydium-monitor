require("dotenv").config();

const websocket=require("ws");
const {Connection, Keypair, PublicKey}=require("@solana/web3.js")
const Client=require("@triton-one/yellowstone-grpc")
const fs=require("fs");
const path=require("path");
const express=require('express');
const http=require('http')
const {Bot,Context,session}=require("grammy");
const { pumpfunSwapTransaction, swapTokenRapid } = require("./swap");
const bs58=require("bs58");
const {  LIQUIDITY_STATE_LAYOUT_V4, Liquidity,MARKET_STATE_LAYOUT_V3,Market,poolKeys2JsonInfo, ApiPoolInfoV4, SPL_MINT_LAYOUT} = require('@raydium-io/raydium-sdk');

const FULL_BONDINGCURVE_MARKET_CAP=60000;
const PUMPFUN_RAYDIUM_MIGRATION="39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg"
const RAYDIUM_OPENBOOK_AMM="675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
const SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';
const RAYDIUM_AUTHORITY="5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const connection = new Connection(process.env.RPC_URL);//Web3.js Connection

const app=express();

app.get("/",(req,res)=>{
    return res.json({status:"success"});
})
app.get("/pumpfun/tokens",(req,res)=>{
    const files=fs.readdirSync(path.resolve(__dirname,"logs"));
    let bodyStr=``;
    for(var oneLog of files){
        bodyStr+=`<a href="/pumpfun/tokens/${oneLog}" >${oneLog}</a><br/>`
    }
    return res.send(bodyStr);

})
app.get("/pumpfun/tokens/:mint/download",async (req,res)=>{
    const targetToken=req.params.mint;
    if(!fs.existsSync(path.resolve(__dirname,"logs",targetToken)))
        return res.json({status:"error",error:"NO_LOG"});
    return res.download(path.resolve(__dirname,"logs",targetToken),`${targetToken}.csv`)
})
app.get("/pumpfun/tokens/:mint",(req,res)=>{
    const targetToken=req.params.mint;
    if(!fs.existsSync(path.resolve(__dirname,"logs",targetToken))) return res.json({status:"error",error:"NO_LOG"});
    const fileContent=fs.readFileSync(path.resolve(__dirname,"logs",targetToken),{encoding:"utf-8"})
    const fileContentData=fileContent.split("\n");
    let bodyStr=`
    <style>
    table, th, td {
        border: 1px solid black;
        border-collapse: collapse;
        text-align:center;
    }
    </style>
    <a href="/pumpfun/tokens/${targetToken}/download" ><h4>Download</h4></a>
    <table >
    `;
    for(var oneLine of fileContentData){
        bodyStr+="<tr>"
        var lineData=oneLine.split(",")
        for(var oneData of lineData){
            bodyStr+=`<td>${String(oneData).length>30?String(oneData).slice(0,5)+"...":oneData}</td>`
        }
        bodyStr+="</tr>"
    }
    bodyStr+="</table>"
    return res.send(bodyStr);

})

const server=http.createServer(app);
server.listen(8003,()=>{
    console.log(`Data logging server started...`)
})



if(!fs.existsSync(path.resolve(__dirname,"logs"))){
    fs.mkdirSync(path.resolve(__dirname,"logs"))
}

if(!fs.existsSync(path.resolve(__dirname,"clients"))){
    fs.mkdirSync(path.resolve(__dirname,"clients"))
}

const clients=fs.readdirSync(path.resolve(__dirname,"clients"));

const bot = new Bot(process.env.TELEGRAM_TOKEN);
const botClients=[];
for(var client of clients){
    botClients.push(Number(client));
}

bot.api.sendMessage("@pumpfun_collector",`
    <b>Monitor's alarm!</b>\n
    Bot is started!\n
`,{
    parse_mode:"HTML",
    link_preview_options:{
        is_disabled:true
    }
});

bot.api.sendMessage("@pumpfun_growth_monitor",`
    <b>Monitor's alarm!</b>\n
    Bot is started!\n
`,{
    parse_mode:"HTML",
    link_preview_options:{
        is_disabled:true
    }
});

var solPrice=130;

async function getSolPrice(){
    try {
        const solPriceRes=await fetch(`https://api-v3.raydium.io/mint/price?mints=So11111111111111111111111111111111111111112`);
        const solPriceData=await solPriceRes.json();
        if(!solPriceData.success){
            return;
        }
        var solPrice=Number(solPriceData.data['So11111111111111111111111111111111111111112'])
        return solPrice;
    } catch (error) {
        
    }
}
setTimeout(async () => {
    solPrice=await getSolPrice();
    console.log(`Initial SOL Price : ${solPrice} $`)
}, 0);


setInterval(async ()=>{
    const newSolPrice=await getSolPrice();
    if(newSolPrice) solPrice=newSolPrice;
    console.log(`SOL Price Updated : ${solPrice} $`)
},60000)

const pumpfunTokens={}

function percentAlert(message,percent){
    if(!pumpfunTokens[message.mint]) return;
    if(pumpfunTokens[message.mint][`percent_${percent}`]) return;
    const currentTime=new Date();
    pumpfunTokens[message.mint][`percent_${percent}`]=currentTime.getTime();
    bot.api.sendMessage("@pumpfun_collector",`
<b>💊 Token was grown as ${percent} % 💊</b>

<b>Name : ${pumpfunTokens[message.mint].name}</b>
<b>Symbol : ${pumpfunTokens[message.mint].symbol}</b>


<b>Mint : </b>
<code>${message.mint}</code>


<b>BondingCurve : </b>
<code>${message.bondingCurveKey}</code>


<b>Market Cap in SOL : </b>${message.marketCapSol} SOL
<b>Market Cap in USD : </b>${((message.marketCapSol*solPrice)/1000).toFixed(2)} K$
<b>vSOL in bonding curve : </b>${message.vSolInBondingCurve} SOL
<b>Number of Buy Trades : </b>${pumpfunTokens[message.mint].numberOfBuyTrades}
<b>Number of Sell Trades : </b>${pumpfunTokens[message.mint].numberOfSellTrades}
<b>Total Number of Trades : </b>${pumpfunTokens[message.mint].numberOfBuyTrades+pumpfunTokens[message.mint].numberOfSellTrades}

<a href="http://64.225.22.236:8003/pumpfun/tokens/${message.mint}" >History</a> | <a href="https://photon-sol.tinyastro.io/en/lp/${message.bondingCurveKey}" >Photon</a>
    `,{
        parse_mode:"HTML",
        link_preview_options:{
            is_disabled:true
        }
    });
}

function filterAlert(){

}

function websocketConnect(){
    
    const ws=new websocket("wss://pumpportal.fun/api/data");
    ws.on("close",()=>{
        setTimeout(() => {
            websocketConnect()
        }, 2000);
    })
    ws.on("message",(data)=>{
        const message=JSON.parse(data)
        if(!message.txType) {
            console.log(message);
            return;
        }
        const currentTime=new Date();
        const now=currentTime.getTime();
        if(message.txType=="create"){
            pumpfunTokens[message.mint]={
                ...message,
                created:now,
                initMarketCapSol:message.marketCapSol,
                numberOfBuyTrades:0,
                numberOfSellTrades:0,
                numberOfBuyTradesAfterDevSold:0,
                numberOfSellTradesAfterDevSold:0,
                devSold:null,
                devSoldMarketCapSol:0,
                prevMarketCapSol:message.marketCapSol,
                prevVSolInBondingCurve:message.vSolInBondingCurve,
                volumeSol:message.vSolInBondingCurve-30,
                maxPoint:message.marketCapSol,
                updated:now,
                percent_10:null,
                percent_30:null,
                percent_50:null,
                percent_60:null,
                percent_70:null,
                percent_80:null,
                percent_90:null,
                percent_95:null,
                alerted:null
                // maxBoughtAmount:message.vSolInBondingCurve-30,
                // maxBoughtAddress:message.traderPublicKey
            }
            if(fs.existsSync(path.resolve(__dirname,"logs",message.mint))){
                fs.unlinkSync(path.resolve(__dirname,"logs",message.mint))
            }
            fs.appendFileSync(path.resolve(__dirname,"logs",message.mint),`name,symbol,mint,creator,created\n`);
            fs.appendFileSync(path.resolve(__dirname,"logs",message.mint),`${message.name},${message.symbol},${message.mint},${message.traderPublicKey},${currentTime.toISOString()}\n`);
            fs.appendFileSync(path.resolve(__dirname,"logs",message.mint),`\n`)
            fs.appendFileSync(path.resolve(__dirname,"logs",message.mint),`time,trader,txType,marketCapSol,marketCapUsd,vSOlInBondingCurve,tradedSolAmount,tradedTokenAmount,Liquidity\n`)
            let payload = {
                method: "subscribeTokenTrade",
                keys: [message.mint]
            }
            ws.send(JSON.stringify(payload))
        }else {
            if(!pumpfunTokens[message.mint]) return;
            if(message.txType=="buy"){
                if(pumpfunTokens[message.mint]&&message.marketCapSol>pumpfunTokens[message.mint].maxPoint){
                    pumpfunTokens[message.mint].maxPoint=message.marketCapSol;
                }
                pumpfunTokens[message.mint].numberOfBuyTrades+=1;
            }
            if(message.txType=="sell"){
                pumpfunTokens[message.mint].numberOfSellTrades+=1;
            }
            const marketCapUsd=solPrice*message.marketCapSol;

            
            // if(marketCapUsd/FULL_BONDINGCURVE_MARKET_CAP>0.95){
            if((message.vSolInBondingCurve-30)/85>0.95){
                // if((!pumpfunTokens[message.mint].percent_95)) pumpfunSwapTransaction(message.mint,0.001,true)
                percentAlert(message,95);
            }
            // else if(marketCapUsd/FULL_BONDINGCURVE_MARKET_CAP>0.9){
            else if((message.vSolInBondingCurve-30)/85>0.9){
                // if((!pumpfunTokens[message.mint].percent_90)&&pumpfunTokens[message.mint].numberOfSellTrades>80) pumpfunSwapTransaction(message.mint,0.1,true)
                percentAlert(message,90);
            }
            // else if(marketCapUsd/FULL_BONDINGCURVE_MARKET_CAP>0.8){
            else if((message.vSolInBondingCurve-30)/85>0.8){
                percentAlert(message,80);
            }
            // else if(marketCapUsd/FULL_BONDINGCURVE_MARKET_CAP>0.7){
            else if((message.vSolInBondingCurve-30)/85>0.7){
                percentAlert(message,70);
            }
            // else if(marketCapUsd/FULL_BONDINGCURVE_MARKET_CAP>0.6){
            else if((message.vSolInBondingCurve-30)/85>0.6){
                percentAlert(message,60);
            }
            // else if(marketCapUsd/FULL_BONDINGCURVE_MARKET_CAP>0.5){
            else if((message.vSolInBondingCurve-30)/85>0.5){
                percentAlert(message,50);
            }
            // else if(marketCapUsd/FULL_BONDINGCURVE_MARKET_CAP>0.3){
            //     percentAlert(message,30);
            // }
            if(((message.vSolInBondingCurve-30)/85)>=0.5&&((message.vSolInBondingCurve-30)/85<=0.6)){
                if((pumpfunTokens[message.mint].numberOfSellTrades+pumpfunTokens[message.mint].numberOfBuyTrades)>=75){
                    if(pumpfunTokens[message.mint].numberOfSellTrades/(pumpfunTokens[message.mint].numberOfBuyTrades)>=0.35){
                        if(!pumpfunTokens[message.mint].alerted){
                            pumpfunTokens[message.mint].alerted=now;
                        bot.api.sendMessage("@pumpfun_growth_monitor",`
<b>💊 Token was grown as 50 % 💊</b>

<b>Name : ${pumpfunTokens[message.mint].name}</b>
<b>Symbol : ${pumpfunTokens[message.mint].symbol}</b>


<b>Mint : </b>
<code>${message.mint}</code>


<b>BondingCurve : </b>
<code>${message.bondingCurveKey}</code>


<b>Market Cap in SOL : </b>${message.marketCapSol} SOL
<b>Market Cap in USD : </b>${((message.marketCapSol*solPrice)/1000).toFixed(2)} K$
<b>vSOL in bonding curve : </b>${message.vSolInBondingCurve} SOL
<b>Number of Buy Trades : </b>${pumpfunTokens[message.mint].numberOfBuyTrades}
<b>Number of Sell Trades : </b>${pumpfunTokens[message.mint].numberOfSellTrades}
<b>Total Number of Trades : </b>${pumpfunTokens[message.mint].numberOfBuyTrades+pumpfunTokens[message.mint].numberOfSellTrades}

<a href="http://64.225.22.236:8003/pumpfun/tokens/${message.mint}" >History</a> | <a href="https://photon-sol.tinyastro.io/en/lp/${message.bondingCurveKey}" >Photon</a>
`
                        ,{
                            parse_mode:"HTML",
                            link_preview_options:{
                                is_disabled:true
                            }
                        });
                    }
                    }
                }
            }

            if(fs.existsSync(path.resolve(__dirname,"logs",message.mint))){
                fs.appendFileSync(path.resolve(__dirname,"logs",message.mint),`${currentTime.toISOString()},${message.traderPublicKey},${message.txType},${message.marketCapSol} SOL,${(marketCapUsd/1000).toFixed(2)}K $,${message.vSolInBondingCurve},${message.vSolInBondingCurve-pumpfunTokens[message.mint].prevVSolInBondingCurve},${message.tokenAmount} ${pumpfunTokens[message.mint].symbol},${2*message.vSolInBondingCurve}\n`);
            }
            pumpfunTokens[message.mint].volumeSol+=(message.vSolInBondingCurve-pumpfunTokens[message.mint].prevVSolInBondingCurve)
            pumpfunTokens[message.mint].prevMarketCapSol=message.marketCapSol;
            pumpfunTokens[message.mint].prevVSolInBondingCurve=message.vSolInBondingCurve;
            pumpfunTokens[message.mint].updated=now;
        }
    })
    ws.on('open', function open() {

        let payload = {
            method: "subscribeNewToken", 
        }
        ws.send(JSON.stringify(payload));
    });
    setInterval(async () => {
        for(var token of Object.keys(pumpfunTokens)){
            const currentTime=new Date();
            const now=currentTime.getTime()
            const updated=pumpfunTokens[token].updated;
            if((now-updated)>(20*60000)){
                delete pumpfunTokens[token];
                fs.unlinkSync(path.resolve(__dirname,"logs",token))
                payload={
                    method: "unsubscribeTokenTrade",
                    keys: [token] 
                }
                ws.send(JSON.stringify(payload))
            }
        }
    }, 10*60000);
    
}

websocketConnect()
bot.start();

const poolsFromPumpfun={}
const geyserMarkets={}

function connectGeyser(){
    const client =new Client.default("http://38.55.73.101:10000/",undefined,undefined);
    client.getVersion()
    .then(async version=>{
        try {
            console.log(version)
            const request =Client.SubscribeRequest.fromJSON({
                accounts: {},
                slots: {},
                transactions: {
                    raydium: {
                        vote: false,
                        failed: false,
                        signature: undefined,
                        accountInclude: [RAYDIUM_OPENBOOK_AMM],
                        accountExclude: [],
                        accountRequired: [],
                    },
                },
                transactionsStatus: {},
                entry: {},
                blocks: {},
                blocksMeta: {},
                accountsDataSlice: [],
                ping: undefined,
                commitment: Client.CommitmentLevel.PROCESSED
            })
        
            const stream =await client.subscribe();
            stream.on("data", async (data) => {
                // console.log(data.transaction.transaction)
                if(data.transaction&&data.transaction.transaction&&data.transaction.transaction.signature) {
                    const sig=bs58.encode(data.transaction.transaction.signature)
                    const transaction=data.transaction.transaction;
                    // console.log(`https://solscan.io/tx/${sig}`)
                    if(transaction.meta.logMessages.some(log=>log.includes("InitializeMint")||log.includes("initialize2"))){
                        // console.log(transaction)
                        var raydiumPoolProgramIndex=0;
                        const allAccounts=[];
                        var from_pumpfun=false;
                        transaction.transaction.message.accountKeys.map((account,index)=>{
                            if(!account) return;
                            const accountID=bs58.encode(account);
                            allAccounts.push(accountID);
                            // console.log(accountID)
                            if(accountID==RAYDIUM_OPENBOOK_AMM){
                                raydiumPoolProgramIndex=index;
                            }
                            if(accountID==PUMPFUN_RAYDIUM_MIGRATION){
                                from_pumpfun=true;
                            }
                        })
                        if(!from_pumpfun){
                            console.log("NOT_FROM_PUMPFUN!!!");
                            return;
                        }
                        const swapInstruction = (transaction?.transaction.message.instructions).find(instruction =>instruction.programIdIndex==raydiumPoolProgramIndex);
                        if(!swapInstruction){
                            console.log("NO_SWAP_INSTRUCTION");
                            return;
                        }
                        const accounts=swapInstruction.accounts;
                        if (!accounts) {
                            console.log("No accounts found in the transaction.");
                            return;
                        }
                        console.log(`https://solscan.io/tx/${sig}`)
                        const tokenAIndex = 8;
                        const tokenBIndex = 9;
                        const lpMintIndex = 7;
                        const marketKeyIndex = 16;
                        if(!transaction.transaction.message.accountKeys[accounts[tokenAIndex]]) return;
                        if(!transaction.transaction.message.accountKeys[accounts[tokenBIndex]]) return;
                        if(!transaction.transaction.message.accountKeys[accounts[marketKeyIndex]]) return;
                        const tokenAAccount = bs58.encode(transaction.transaction.message.accountKeys[accounts[tokenAIndex]]);
                        const tokenBAccount = bs58.encode(transaction.transaction.message.accountKeys[accounts[tokenBIndex]]);
                        const marketAccountKey= bs58.encode(transaction.transaction.message.accountKeys[accounts[marketKeyIndex]]);
                        const targetToken=(tokenAAccount==SOL_MINT_ADDRESS)?tokenBAccount:tokenAAccount;
                        const quoted=(tokenAAccount==SOL_MINT_ADDRESS)?true:false;
                        var tokenInfoData=await connection.getParsedAccountInfo(new PublicKey(targetToken),"processed");
                        var timer=0;
                        if(!tokenInfoData.value) while(!tokenInfoData.value){
                            tokenInfoData=await connection.getParsedAccountInfo(new PublicKey(targetToken),"processed");;
                            timer++;
                            if(timer>100) break;
                        }
                        if(!tokenInfoData.value){
                            console.log("NO TOKEN INFO!!!");
                            return;
                        }
                        const tokenInfo=tokenInfoData.value.data.parsed.info;
                        if(tokenInfo.freezeAuthority) {
                            console.log("FROZEN From GEYSER!!!")
                            return;
                        }
                        if(tokenInfo.mintAuthority) {
                            console.log("NOT RENOUNCED FROM GEYSER!!!")
                            return;
                        }
                        console.log(tokenInfo)
                        console.log({targetToken,quoted})
                        var largestHoldersData=await connection.getTokenLargestAccounts(new PublicKey(targetToken),"processed");

                        const theLargestHolder=await connection.getParsedAccountInfo(largestHoldersData.value[0].address,"processed");
                        const theLargestOwner=theLargestHolder?.value?.data?.parsed?.info?.owner;
                        var dangerous=false;
                        if((theLargestOwner!=PUMPFUN_RAYDIUM_MIGRATION)&&(theLargestOwner!=RAYDIUM_AUTHORITY)){
                            dangerous=true;
                            console.log("DANGEROUS!!!")
                            for(var oneHolder of largestHoldersData.value){
                                console.log(`${oneHolder.address.toBase58()} ${(oneHolder.uiAmount/(Number(tokenInfo.supply)/(10**(tokenInfo.decimals+2)))).toFixed(2)}%`)
                            }
                            // return;
                        }
                        
                        poolsFromPumpfun[bs58.encode(transaction.transaction.message.accountKeys[accounts[4]])]=targetToken;
                        var [baseMintAccount, quoteMintAccount,marketAccount] = await connection.getMultipleAccountsInfo([
                            new PublicKey(tokenAAccount),
                            new PublicKey(tokenBAccount),
                            new PublicKey(marketAccountKey),
                        ],"processed");
                        timer=0;
                        if(!baseMintAccount) while (!baseMintAccount) {
                            console.log("NO BASEMINT ACCOUNT!!!!")
                            baseMintAccount=await connection.getAccountInfo(new PublicKey(tokenAAccount));
                            timer++;
                            if(timer>100) break;
                        }
                        if(!baseMintAccount) return;
                        timer=0;
                        if(!quoteMintAccount) while (!quoteMintAccount) {
                            console.log("NO QUOTEMINT ACCOUNT!!!!")
                            quoteMintAccount=await connection.getAccountInfo(new PublicKey(tokenBAccount));
                            timer++;
                            if(timer>100) break;
                        }
                        if(!quoteMintAccount) return;
                        timer=0;
                        
                        if(!marketAccount) while (!marketAccount) {
                            console.log("NO MARKET ACCOUNT!!!!")
                            marketAccount=await connection.getAccountInfo(new PublicKey(marketAccountKey));
                            timer++;
                            if(timer>10000) break;
                        }
                        
                        var poolInfos;
                        if(marketAccount){
                            const baseMintInfo = SPL_MINT_LAYOUT.decode(baseMintAccount.data)
                            const quoteMintInfo = SPL_MINT_LAYOUT.decode(quoteMintAccount.data)
                            const marketInfo = MARKET_STATE_LAYOUT_V3.decode(marketAccount.data)
                            poolInfos={
                                id: new PublicKey(bs58.encode(transaction.transaction.message.accountKeys[accounts[4]])),
                                baseMint: new PublicKey(bs58.encode(transaction.transaction.message.accountKeys[accounts[8]])),
                                quoteMint: new PublicKey(bs58.encode(transaction.transaction.message.accountKeys[accounts[9]])),
                                lpMint: new PublicKey(bs58.encode(transaction.transaction.message.accountKeys[accounts[7]])),
                                baseDecimals: baseMintInfo.decimals,
                                quoteDecimals: quoteMintInfo.decimals,
                                lpDecimals: baseMintInfo.decimals,
                                version: 4,
                                programId: new PublicKey(RAYDIUM_OPENBOOK_AMM),
                                authority: new PublicKey(bs58.encode(transaction.transaction.message.accountKeys[accounts[5]])),
                                openOrders: new PublicKey(bs58.encode(transaction.transaction.message.accountKeys[accounts[6]])),
                                targetOrders: new PublicKey(bs58.encode(transaction.transaction.message.accountKeys[accounts[12]])),
                                baseVault: new PublicKey(bs58.encode(transaction.transaction.message.accountKeys[accounts[10]])),
                                quoteVault: new PublicKey(bs58.encode(transaction.transaction.message.accountKeys[accounts[11]])),
                                withdrawQueue: PublicKey.default,
                                lpVault: PublicKey.default,
                                marketVersion: 3,
                                marketProgramId: marketAccount.owner,
                                marketId: new PublicKey(bs58.encode(transaction.transaction.message.accountKeys[accounts[16]])),
                                marketAuthority: Market.getAssociatedAuthority({ programId: marketAccount.owner, marketId: new PublicKey(bs58.encode(transaction.transaction.message.accountKeys[accounts[16]])) }).publicKey,
                                marketBaseVault: marketInfo.baseVault,
                                marketQuoteVault: marketInfo.quoteVault,
                                marketBids: marketInfo.bids,
                                marketAsks: marketInfo.asks,
                                marketEventQueue: marketInfo.eventQueue,
                            };
                        }
                        if(!poolInfos) {
                            console.log("NO_POOLINFO")
                            console.log({targetToken,quoted})
                            console.log(`https://solscan.io/tx/${sig}`)
                            return;
                        }
                        const solVault=(poolInfos.baseMint.toString()==SOL_MINT_ADDRESS)?poolInfos.baseVault:poolInfos.quoteVault;
                        var solAmount=0;
                        var solAmountTimer=0;
                        var solAmountData;
                        timer=0;
                        if(!solAmountData)
                        while(!solAmountData){
                            try {
                                solAmountData=await connection.getTokenAccountBalance(solVault,"processed");
                            } catch (error) {
                                
                            }
                            
                            timer++;
                            if(timer>100) break;
                        }
                        if(!solAmountData){
                            console.log("FAILED TO FETCH SOL AMOUNT");
                            return;
                        }
                        solAmount=solAmountData.value.uiAmount;
                        console.log({solAmount})
                        geyserMarkets[targetToken]=poolInfos;

                        await swapTokenRapid(targetToken,poolInfos,0.1,true);
                        var largestHoldersStr=`\n`;
                        for(var oneHolder of largestHoldersData.value){
                            largestHoldersStr+=`<a href="https://solscan.io/account/${oneHolder.address.toBase58()}" >${oneHolder.address.toBase58()}</a> <b>${(oneHolder.uiAmount/(Number(tokenInfo.supply)/(10**(tokenInfo.decimals+2)))).toFixed(2)}%</b>\n`
                        }
                        largestHoldersStr+=`\n`                
                        
                        bot.api.sendMessage("@pumpfun_collector",
                        `<b>💥 New Pool from GEYSER 💥</b>\n\n<b>Mint : </b>\n<code>${targetToken}</code>\n\n<b>Quoted : </b>${quoted?"✅":"❌"}\n\n<b>LP Value : </b><b>${solAmount}</b> SOL \n\n<b>Dangerous : </b>${dangerous?"✅":"❌"}\n<b>The Largest Holders : </b>\n${largestHoldersStr}<a href="http://64.225.22.236:8003/pumpfun/tokens/${targetToken}" >History</a> | <a href="https://solscan.io/tx/${sig}" >LP</a> | <a href="https://photon-sol.tinyastro.io/en/lp/${poolInfos.id.toString()}">Photon</a> | <a href="https://dexscreener.com/solana/${poolInfos.id.toString()}" >DexScreener</a> \n`,
                        {parse_mode:"HTML",link_preview_options:{is_disabled:true}})
                    }
                    else if(transaction.meta.logMessages.some(log=>log.includes("Transfer"))){
                        const numberOfSigners=transaction.transaction.message.header.numRequiredSignatures;
                        var allAccounts=[]
                        var raydiumPoolProgramIndex;
                        transaction.transaction.message.accountKeys.map((account,index)=>{
                            if(!account) return;
                            const accountID=bs58.encode(account);
                            allAccounts.push(accountID);
                            if(accountID==RAYDIUM_OPENBOOK_AMM){
                                raydiumPoolProgramIndex=index;
                            }
                        })
                        const swapInstruction=(transaction?.transaction.message.instructions).find(instruction =>instruction.programIdIndex==raydiumPoolProgramIndex);
                        if(!swapInstruction) return;
                        const amm=allAccounts[swapInstruction.accounts[1]]
                        if(poolsFromPumpfun[amm]){
                            const swapAccounts=[];
                            for(var i=0;i<swapInstruction.accounts.length;i++){
                                swapAccounts.push(allAccounts[swapInstruction.accounts[i]])
                            }
                            console.log(`https://solscan.io/tx/${sig}`)
                            console.log(swapAccounts)
                            const targetToken=poolsFromPumpfun[amm];
                            // swapFromAccounts(targetToken,swapAccounts,0.0001,false);
                            delete poolsFromPumpfun[amm]
                        }
                    }
                }
            });
            await new Promise((resolve, reject) => {
                stream.write(request, (err) => {
                    if (err === null || err === undefined) {
                    resolve();
                    } else {
                    reject(err);
                    }
                });
            }).catch((reason) => {
                console.error(reason);
                throw reason;
            });
        } catch (error) {
            console.log(error)
            console.log("RECONNECTING!!!")
            setTimeout(() => {
                connectGeyser()
            }, 3000);
        }
    });
}

connectGeyser();