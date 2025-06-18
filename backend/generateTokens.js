const crypto = require('crypto');
const Airtable = require('airtable');
const base = new Airtable({ apiKey: process.env.AIRTABLE_KEY }).base(process.env.AIRTABLE_BASE_ID);

(async () => {
    const users = await base('Users').select().all();

    for (const user of users) {
        const email = user.fields.Email;
        const token = crypto.createHash('md5').update(email).digest('hex');

        await base('Meal URL').create([
            {
                fields: {
                    Name: user.fields.Name,
                    Email: email,
                    'Unique ID': token,
                    URL: `http://localhost:3000/meal-plan?customer=${token}`,
                },
            },
        ]);
    }
})();
