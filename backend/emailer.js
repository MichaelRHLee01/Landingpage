const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const Airtable = require('airtable');
const base = new Airtable({ apiKey: process.env.AIRTABLE_KEY }).base(process.env.AIRTABLE_BASE_ID);

async function sendWeeklyEmails() {
    const records = await base('Open Orders').select().all();

    for (const record of records) {
        const email = record.fields.Email;
        const token = record.fields['Unique ID'];
        const url = `http://localhost:3000/meal-plan?customer=${token}`;
        // Website name

        const msg = {
            to: email,
            from: 'raehyunl@andrew.cmu.edu',
            // Website name
            subject: 'Your Weekly Meal Plan',
            html: `<p>Edit your plan here: <a href="${url}">${url}</a></p>`,
        };

        await sgMail.send(msg);
    }
}

module.exports = { sendWeeklyEmails };
