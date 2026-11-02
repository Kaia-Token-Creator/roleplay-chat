import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const section=html.split('<!-- MySecretPass.link Promo Modal: General text chat only -->')[1]?.split('<!-- Image & Video Suggestion Modal -->')[0];

test('replaces the old States War advert with a single accessible MySecretPass.link popup',()=>{
 assert.ok(section);
 assert.equal(html.split('id="mySecretPassPromoModal"').length-1,1);
 assert.ok(section.includes('aria-labelledby="mySecretPassPromoTitle"'));
 assert.ok(section.includes('href="https://mysecretpass.link/"'));
 assert.ok(section.includes('target="_blank"')&&section.includes('rel="noopener noreferrer"'));
 assert.doesNotMatch(html,/Take Over America|stateswar\.com|SAVE AMERICA|States War|statesWar|StatesWar/);
});
test('explains all three ways to earn, without confusing the commission rates',()=>{
 assert.match(section,/SELL YOUR CONTENT/);
 assert.match(section,/Have content\?/);
 assert.match(section,/AFFILIATE · 4%/);
 assert.match(section,/No content\?/);
 assert.match(section,/REFERRAL · UP TO 40%/);
 assert.match(section,/other sellers/);
 assert.match(section,/Share it\. Get paid\. One link\./);
});
test('keeps existing general-text-chat timing and dismiss behavior connected',()=>{
 assert.match(html,/function startMySecretPassPromoForGeneral\(session\)/);
 assert.match(html,/if \(!session \|\| session\.tier !== "general"\) return;/);
 assert.match(html,/startMySecretPassPromoForGeneral\(session\);/);
 assert.match(html,/10 \* 60 \* 1000/);
 assert.match(html,/getElementById\("closeMySecretPassPromo"\)\?\.addEventListener\("click", closeMySecretPassPromo\)/);
 assert.match(html,/getElementById\("mySecretPassPromoLater"\)\?\.addEventListener\("click", closeMySecretPassPromo\)/);
 assert.match(html,/e\.target\?\.id === "mySecretPassPromoModal"/);
 const matches=[...section.matchAll(/<div\b/g)].length;
 const closes=[...section.matchAll(/<\/div>/g)].length;
 assert.equal(matches,closes,'promo markup must have balanced divs');
});
