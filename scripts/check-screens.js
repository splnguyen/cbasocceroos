const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE='http://localhost:65268';
const root=path.join(__dirname,'..');
const screens=fs.readdirSync(root).filter(f=>/^screen-.*\.html$/.test(f)).sort();
(async()=>{
  const b=await chromium.launch();
  const p=await(await b.newContext({viewport:{width:1080,height:1920}})).newPage();
  for(const f of screens){
    await p.goto(`${BASE}/${f}?demo=1`,{waitUntil:'domcontentloaded'}).catch(()=>{});
    await p.waitForTimeout(6000);
    const t=await p.evaluate(()=>document.body.innerText||'');
    const bad=/Update failed|Error:|Connecting…|Reconnecting…|Loading…/.exec(t);
    console.log((bad?'WARN '+bad[0].padEnd(14):'ok            ')+'  '+f);
  }
  await b.close();
})();
