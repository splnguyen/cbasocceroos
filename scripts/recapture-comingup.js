const { chromium } = require('playwright');
const path = require('path');
(async()=>{
  const b=await chromium.launch();
  const p=await(await b.newContext({viewport:{width:1080,height:1920}})).newPage();
  await p.goto('http://localhost:62485/screen-comingup.html',{waitUntil:'domcontentloaded'}).catch(()=>{});
  await p.waitForTimeout(7000);
  const out=path.join(__dirname,'..','screenshots','screen-comingup.png');
  await p.screenshot({path:out,clip:{x:0,y:0,width:1080,height:1920}});
  console.log('recaptured', out);
  await b.close();
})();
