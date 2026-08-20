import csv

rows = [
    {
        "founder_name": "Dave Grannan",
        "linkedin_url": "https://linkedin.com/in/grannan",
        "cold_outreach_email": (
            "Subject: Quick question about Vox and voice AI at Marr Labs\n\n"
            "Hi Dave,\n\n"
            "I've been following Marr Labs since your YC W24 launch, and your track record with Vlingo "
            "(powering the first Siri) makes your bet on human-indistinguishable AI voice agents especially "
            "credible. The Vox Mortgage launch, tackling the $85B call-handling market with warm-transfer "
            "handoffs to live agents, is a smart wedge into a very real pain point for lenders.\n\n"
            "I'd love just 15 minutes on a call to learn more about how you're scaling Vox across new verticals "
            "and see if there's a way I could be useful as you grow. Would you have 15 minutes this week or next "
            "for a quick call?\n\n"
            "Best,\nAlex"
        ),
    },
    {
        "founder_name": "Han Shu",
        "linkedin_url": "https://linkedin.com/in/hanshu",
        "cold_outreach_email": (
            "Subject: Impressed by Marr Labs' speech stack (and your Vlingo/Wyth background)\n\n"
            "Hi Han,\n\n"
            "Your path from Vlingo's ASR/NLU stack (which shipped inside the first Siri) through Wyth and into "
            "leading ML at Airbnb and DoorDash gives Marr Labs a rare depth on the technical side of voice AI. "
            "The idea of AI voice agents that are truly indistinguishable from humans, and scalable to the 17 "
            "billion phone-based interactions US businesses handle each year, is a huge opportunity.\n\n"
            "Would you be open to a 15-minute call to talk through how you're approaching the ML/AI architecture "
            "behind Vox as you push toward broader deployment? I'd really value your perspective.\n\n"
            "Best,\nAlex"
        ),
    },
    {
        "founder_name": "Elle Smyth",
        "linkedin_url": "https://linkedin.com/in/ellesmyth",
        "cold_outreach_email": (
            "Subject: RetailReady's compliance engine — 15 min?\n\n"
            "Hi Elle,\n\n"
            "Congrats on RetailReady's traction since YC W24 — going from seeing chargeback pain firsthand at "
            "Stord to building a tablet app that replaces 100+ page routing guides is a great insight-to-product "
            "story, and the $3.3M raise TechCrunch covered is a strong signal the market agrees. Tackling the "
            "$40B/year retailer chargeback problem with a no-training, no-integration tool is exactly the kind of "
            "unsexy-but-massive problem I love seeing YC founders take on.\n\n"
            "Could I grab just 15 minutes of your time for a quick call? I'd love to hear how warehouse teams are "
            "responding to RetailReady and where you're headed next.\n\n"
            "Best,\nAlex"
        ),
    },
    {
        "founder_name": "Sarah Hamer",
        "linkedin_url": "https://linkedin.com/in/sarah-hamer-881bb6126",
        "cold_outreach_email": (
            "Subject: Your Stord-to-RetailReady story + a 15-min ask\n\n"
            "Hi Sarah,\n\n"
            "I loved reading how your time as an industrial engineer at Stord, seeing warehouse teams manually "
            "cross-referencing 100+ page routing guides, directly led to RetailReady. Replacing that paper-based "
            "process with a tablet app that helps warehouses avoid the $40B in annual retailer chargebacks is a "
            "sharp, founder-market-fit story, and the recent $3.3M raise shows it's resonating.\n\n"
            "Would you have 15 minutes for a quick call? I'd love to learn more about how compliance workflows are "
            "changing for your customers and what's next for RetailReady.\n\n"
            "Best,\nAlex"
        ),
    },
    {
        "founder_name": "Yvonne Chou",
        "linkedin_url": "https://linkedin.com/in/yvonne-chou",
        "cold_outreach_email": (
            "Subject: Kater's Butler agent — quick 15-min chat?\n\n"
            "Hi Yvonne,\n\n"
            "Your background building the entire data stack at Crexi, plus years supplying dashboards across "
            "sales, marketing, and finance, clearly shaped Kater's approach of turning one business question into "
            "a full contextualized analysis package. I especially like the Butler AI data agent concept, indexing "
            "a company's 'data map' so business experts stop waiting days for the data team to answer a 'why' "
            "question.\n\n"
            "Would you be open to a 15-minute call? I'd love to hear how enterprise teams are adopting Kater and "
            "what's on the roadmap for Butler.\n\n"
            "Best,\nAlex"
        ),
    },
    {
        "founder_name": "Robin Seitz",
        "linkedin_url": "https://linkedin.com/in/robin-seitz-12029970",
        "cold_outreach_email": (
            "Subject: Kater's data-question engine — 15 minutes?\n\n"
            "Hi Robin,\n\n"
            "Going from distributed systems and full-stack work at Microsoft, Abbott, and Paragon into building "
            "Kater's continuous classification engine is a great fit — turning a single ad-hoc business question "
            "into a full contextualized set of data questions is exactly the kind of systems problem your "
            "background sets you up well for. The framing of companies being 'data-rich, insight-poor' really "
            "resonates.\n\n"
            "Could I get 15 minutes of your time for a quick call? I'd love to hear about the engineering behind "
            "Kater and Butler and how it's evolved since launch.\n\n"
            "Best,\nAlex"
        ),
    },
    {
        "founder_name": "Tianwei Yue",
        "linkedin_url": "https://linkedin.com/in/tianwei-yue",
        "cold_outreach_email": (
            "Subject: Mathos AI's 1M+ students — would love 15 minutes\n\n"
            "Hi Tianwei,\n\n"
            "Mathos AI's growth to over 1M students across 200+ countries, plus a math model that beats GPT-4o "
            "by roughly 20% on quantitative problem-solving accuracy, is a genuinely impressive result for a YC "
            "W24 company. Your path from language-agent research since 2022 into building a model specialized "
            "for personalized math tutoring is a compelling technical story, and the Forbes 30 Under 30 and SXSW "
            "EDU recognition reflect that.\n\n"
            "Would you have 15 minutes for a quick call? I'd love to learn more about how Mathos is approaching "
            "adaptive learning and grading automation for schools.\n\n"
            "Best,\nAlex"
        ),
    },
    {
        "founder_name": "Alex Liao",
        "linkedin_url": "https://linkedin.com/in/alexliaoo",
        "cold_outreach_email": (
            "Subject: Dragoneye's <5-min video detection models — 15 min call?\n\n"
            "Hi Alex,\n\n"
            "Dragoneye's zero-shot Playground, letting developers describe categories and get a working custom "
            "video detection model in under 5 minutes without annotating training data, is a great example of "
            "removing the most painful part of computer vision workflows. Given your background at Jane Street "
            "and Facebook plus a Physics/CS foundation from UPenn, it makes sense you're focused on making "
            "detection accessible to every app.\n\n"
            "Would you be open to a 15-minute call? I'd love to hear more about how teams are using the Playground "
            "in production and where Dragoneye is headed next.\n\n"
            "Best,\nAlex"
        ),
    },
]

with open("cold_outreach.csv", "w", newline="", encoding="utf-8") as f:
    writer = csv.DictWriter(f, fieldnames=["founder_name", "linkedin_url", "cold_outreach_email"])
    writer.writeheader()
    for row in rows:
        writer.writerow(row)

print("done", len(rows))
