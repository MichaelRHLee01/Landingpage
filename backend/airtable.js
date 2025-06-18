const Airtable = require('airtable');
require('dotenv').config();
const base = new Airtable({ apiKey: process.env.AIRTABLE_KEY }).base(process.env.AIRTABLE_BASE_ID);

async function getOrdersByToken(token) {
    const results = [];
    await base('Open Orders')
        .select({
            filterByFormula: `{To_Match_Client_Nutrition} = '${token}'`
        })
        .eachPage((records, fetchNextPage) => {
            results.push(...records.map(r => r.fields));
            fetchNextPage();
        });
    return results;
}


module.exports = { base, getOrdersByToken };
