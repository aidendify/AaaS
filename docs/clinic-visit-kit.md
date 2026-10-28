# Clinic visit kit

Use this on a visit to a clinic owner. The same script, terms and form are in the app under **Clinic visit** (`/clinic#visit`). Saving the form writes the answers into that owner’s account. It does not email, text, or charge anyone.

## How to run it

1. On your laptop, `npm start`, then open http://localhost:3000/clinic.
2. Sign in as the sample clinic, or as the owner’s own account if they already created one.
3. Open **Clinic visit**.
4. Read the ten questions. Write what they actually said.
5. Tick that they heard the free-pilot terms, then **Save visit notes**.

## Ten questions

1. How do new patients reach you today, and which channel brings the most?
2. What happens to an enquiry that comes after hours or when reception is busy?
3. Which clinic software do you use, and what do you pay for it?
4. How do you follow up patients who leave a treatment unfinished?
5. Roughly how many no-shows do you get in a week?
6. How do you ask patients for Google reviews or referrals today?
7. Who handles your social media, and what does it cost?
8. How do you know at month-end whether the clinic made a profit?
9. What takes most of your receptionist’s time that isn’t patient care?
10. The two plans are Self-hosted at ₹2,999 a month, plus a one-time setup and install of ₹9,999 waived on an annual plan, or Hosted at ₹4,999 a month. Both use your own AI key. You pay the provider directly. What would make it a yes?

## Free-pilot terms to say out loud

- Self-hosted is ₹2,999 a month plus a one-time setup and install of ₹9,999, waived on an annual plan. Hosted is ₹4,999 a month, with backups, uptime and updates, and no install. Both plans include the same agents. AI usage is paid by you directly to your provider. This app does not take a card payment.
- Reminders, review requests, posts and payment notes stay as drafts until the owner approves them. Approving records the OK and still does not email, text, post, or collect money.
- WhatsApp is a link the owner opens on their own phone. There is no SMS and no paid WhatsApp API.
- Records stay in this owner account. Another customer cannot read them. Sample rows stay marked demo.
- The owner can export the records, or delete them, from Privacy. Deleting the whole account still needs the password.
- The team sits beside reception. It does not replace the receptionist, and there is no phone menu.
- Either side can stop. Stopping does not send a message to patients.

## What not to promise

Do not promise SMS, a paid WhatsApp inbox, a payment collection, or that AaaS replaces the receptionist. Do not type a real medical history into the sample clinic. If they want their own records, they create an account and import a CSV, or connect Eka.care when that server has `EKA_CLIENT_ID` and `EKA_CLIENT_SECRET` set.
