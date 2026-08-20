import json, csv

with open('founders_data.json') as f:
    data = json.load(f)

rows = []
for company in data['companies']:
    cname = company['name']
    tagline = company['tagline']
    product = company['product']
    for founder in company['founders']:
        first_name = founder['name'].split()[0]
        subject_context = f"Quick question about {cname}"
        email = (
            f"Subject: 15 minutes re: {cname}'s approach to {tagline.lower()}\n\n"
            f"Hi {first_name},\n\n"
            f"I came across {cname} and was really impressed by what you're building - {product}. "
            f"I particularly admired {founder['detail']}, and it's clear that background is paying off in how you've shaped {cname}'s product.\n\n"
            f"I'm reaching out because I'd love to learn more about your approach as {founder['role']} and share a few thoughts on where I think there could be mutual value. "
            f"Would you be open to a quick 15-minute call sometime in the next week or two? I'll work around your schedule.\n\n"
            f"Looking forward to hearing from you, {first_name}.\n\n"
            f"Best,\nAlex"
        )
        rows.append({
            'founder_name': founder['name'],
            'linkedin_url': founder['linkedin'],
            'cold_outreach_email': email
        })

with open('cold_outreach.csv', 'w', newline='', encoding='utf-8') as f:
    writer = csv.DictWriter(f, fieldnames=['founder_name','linkedin_url','cold_outreach_email'])
    writer.writeheader()
    for r in rows:
        writer.writerow(r)

print(f"Wrote {len(rows)} rows")
