import csv

rows = []

def add(name, cls, major, aff, interests, other):
    rows.append([name.strip(), cls, major.strip(), aff, interests.strip(), other.strip()])

# --- Alpha Chi Omega ---
# Site (axo.mit.edu/sisters/) only lists down to Class of 2027; no Class of 2026 (senior) section exists on the page.
axo_2027 = ["Stuti Agarwal","Stephanie Chang","Fatima Hernandez","Sharona Huang","Elizabeth Jackson",
"Anna Kim","Maddy Laws","Priscilla Leang","Nicole Li","Minnie Liang","Molly McCormick","Qingqing Ouyang",
"Anisha Parsan","Lidia Prokopovych","Ruoxi Qian","Pria Sawhney","Fiona Shangguan","Ridhima Singh",
"Jessie Wang","Emily Zhang"]
for n in axo_2027:
    add(n, "2027 (Junior)", "", "Alpha Chi Omega", "", "")
add("(No Class of 2026 seniors listed on AXO website)", "2026 (Senior)", "", "Alpha Chi Omega", "", "Website (axo.mit.edu/sisters) does not list a Class of 2026 section")

# --- Alpha Phi ---
alphaphi_2026 = """Harley Carroll
Gwendolyn Flusche
Kelsey Fontenot
Anakha Ganesh
Ali Gibbs
Morgan Johnson Quamina
Katie Kempff
Madeline Leano
Maanasi Limaye
Leena Mehendale
Hara Moraitaki
Monica Petulla
Nina Petulla
Annika Naveen
Olivia Scarpaci
Alex Shanafield
Claire Underwood
Alice Vranka
Kaya Weiser
Josephine Williams""".strip().split("\n")
for n in alphaphi_2026:
    add(n, "2026 (Senior)", "", "Alpha Phi", "", "")

alphaphi_2027 = [
("Jillian Butler","Brecksville, OH","Math with Computer Science and concentrating in Economics"),
("AnAn Desimone","Brookline, MA","Computer Science, Data Science, and Economics"),
("Alexa Di Sabato","San Francisco, CA","Computer Science and Cognitive Science and Education"),
("Emilie Dubiel","Hobe Sound, FL","Mathematics and Finance with concentration in Economics"),
("Sarah Dufays","Miami, FL","Artificial Intelligence and Decision Making"),
("Elise Echarte","Miami Beach, FL","Mechanical Engineering, Minor in Environment and Sustainability"),
("Nishi Gandra","Mason, OH","Computer Science and Finance"),
("Lia Gonzales","Chandler, AZ","Biological Engineering and Spanish"),
("Emma Hickman","Houston, TX","Mechanical Engineering and Management"),
("Emily Hong","Seoul, South Korea / Boston, MA","Artificial Intelligence and Decision Making, Economics"),
("Cassidy Jennings","Sioux Falls, SD","Artificial Intelligence and Decision Making, Minor in Philosophy"),
("Heather Jensen","Manhattan Beach, CA","Biological Engineering and Environment & Sustainability"),
("Vieyiti Kouadio","Merced, CA","Biological Engineering, and Environment and Sustainability"),
("Arianna Kumar","San Diego, CA","Computation and Cognition and Education"),
("Macy Lehrer","Danville, CA","Artificial Intelligence & Decision-Making and Economics"),
("Ava Malysa","Manhasset, NY","Math and Computer Science"),
("JoJo Miller","Roswell, GA","Biology Major and Theater Arts Concentration"),
("Sophia Min","Naples, FL","Computer Science and Theater Arts"),
("Saachi Mody","Parkland, FL","Computation and Cognition and Women and Gender Studies"),
("Melisande Nabage","New York, NY","Computation and Cognition"),
("Victoria Paesano","Miami, FL","Computer Science and French"),
("Sky Pulling","New York, NY","Mathematics and Computer Science, Robotics and Autonomous Systems"),
("Katrina Romero","Atlanta, GA","Mechanical Engineering, Robotics & Controls and French Concentration"),
("Eileen Sadati","Orange County, CA","Mathematical Economics and Finance"),
("Maria Santos","Garden City, NY","Computation and Cognition"),
("Michelle Sotelo","Westford, MA","Computer Science and Engineering, minor in Art and Design and Spanish"),
("Ayla Sumer","Dallas, TX","Chemical-Biological Engineering, Finance and Literature"),
("Ana Tejeda","Boston, MA","Artificial Intelligence and Decision Making, minor in Mechanical Engineering and Finance"),
("Janie Thomas","Houston, TX","Cognitive Science and Spanish concentration"),
("Jane Tortorella","Old Greenwich, CT","Electrical Engineering and Political Science"),
("Victoria Wong","Millburn, NJ","Computer Science and Finance, Music"),
("Katherine Zhou","New Providence, NJ","Mechanical Engineering"),
]
for n, h, m in alphaphi_2027:
    add(n, "2027 (Junior)", m, "Alpha Phi", "", f"Hometown: {h}")

# --- Delta Phi Epsilon ---
dphie_2026 = [
    ("Angela Zhang", "Course 6-3", "Belleuve, WA"),
    ("Catherine Kung", "Courses 20 and 6-9", "Birmingham, AL"),
    ("Emma Shi", "Course 6-14", "Sammamish, WA"),
    ("Kaylee Ji", "Courses 6-9 and 18", "Lexington, MA"),
    ("Lillian You", "", ""),
    ("Melinda Liu", "Courses 6-14 and 15-3", "Tampa, FL"),
    ("Michelle Xiang", "Course 18C", "Austin, TX"),
    ("Radia Wong", "Course 6-3", "San Jose, CA"),
    ("Reina Wang", "Course 6-4", "Shanghai, China"),
]
dphie_2027 = [
    ("Kaitlyn Li", "Course 6-4", "Rockville, MD"),
    ("Rita Braun", "Course 12", "Bismarck, ND"),
    ("Stephanie Han", "Course 15-3", "Okemos, MI"),
]
for n, m, h in dphie_2026:
    add(n, "2026 (Senior)", m, "Delta Phi Epsilon", "", f"Hometown: {h}" if h else "")
for n, m, h in dphie_2027:
    add(n, "2027 (Junior)", m, "Delta Phi Epsilon", "", f"Hometown: {h}" if h else "")

# --- Kappa Alpha Theta ---
def parse_theta_block(text, cls_label):
    entries = []
    blocks = [b.strip() for b in text.strip().split("\n\n") if b.strip()]
    for b in blocks:
        lines = [l.strip() for l in b.split("\n") if l.strip()]
        name = lines[0]
        hometown = ""
        major = ""
        activities = ""
        for l in lines[1:]:
            if l.lower().startswith("hometown:"):
                hometown = l.split(":",1)[1].strip()
            elif l.lower().startswith("major:"):
                major = l.split(":",1)[1].strip()
            elif l.lower().startswith("activities:"):
                activities = l.split(":",1)[1].strip()
        entries.append((name, hometown, major, activities))
    return entries

with open("theta_2026.txt") as f:
    theta_2026_text = f.read()
with open("theta_2027.txt") as f:
    theta_2027_text = f.read()

for name, hometown, major, activities in parse_theta_block(theta_2026_text, "2026"):
    other = f"Hometown: {hometown}" if hometown else ""
    add(name.title(), "2026 (Senior)", major, "Kappa Alpha Theta", activities, other)

for name, hometown, major, activities in parse_theta_block(theta_2027_text, "2027"):
    other = f"Hometown: {hometown}" if hometown else ""
    add(name.title(), "2027 (Junior)", major, "Kappa Alpha Theta", activities, other)

# --- Pi Beta Phi ---
# Site (mit.pibetaphi.org/members) only lists Class of 2027, 2028, 2029; no Class of 2026 section exists.
add("(No Class of 2026 seniors listed on Pi Beta Phi website)", "2026 (Senior)", "", "Pi Beta Phi", "", "Website (mit.pibetaphi.org/members) does not list a Class of 2026 section")

pbp_2027 = ["Cate Almasy","Lauren Bagley","Isabella Barillas","Ruby Beck","Julia Bennett","Cassidy Bristol",
"Reagan Brummel","Aashna Chhabria","Samantha Chin","Sophie Chou","Emerson Devitt","Grace Douglass",
"Katelyn Gan","Sophie Garrahan","Amelia Griggs","Julianna Ho","Emily Kubaska","Ellee Lee","Sophia Liu",
"Bella Lopez","Isabelle Louie","Ana Sofia Manterola","Piper McClure","Yashi Modi","Katya Neklyudova",
"Trang Phan","Lillian Poag","Emma Roberts","Alessa Ruiz de Chavez","Ariel Skolnick","Sophia Song",
"Meyline Szczepanski","Alex Tanaka","Zoe Turner","Emma Willis"]
for n in pbp_2027:
    add(n, "2027 (Junior)", "", "Pi Beta Phi", "", "")

# --- Sigma Kappa ---
def parse_sk_block(text):
    entries = []
    blocks = [b.strip() for b in text.strip().split("\n\n") if b.strip()]
    for b in blocks:
        lines = [l.strip() for l in b.split("\n") if l.strip()]
        name = lines[0]
        hometown = ""
        major = ""
        activities = ""
        for l in lines[1:]:
            if l.lower().startswith("hometown:"):
                hometown = l.split(":",1)[1].strip()
            elif l.lower().startswith("major:"):
                major = l.split(":",1)[1].strip()
            elif l.lower().startswith("activities:"):
                activities = l.split(":",1)[1].strip()
        entries.append((name, hometown, major, activities))
    return entries

with open("sigmakappa_2026.txt") as f:
    sk_2026_text = f.read()
with open("sigmakappa_2027.txt") as f:
    sk_2027_text = f.read()

for name, hometown, major, activities in parse_sk_block(sk_2026_text):
    other = f"Hometown: {hometown}" if hometown else ""
    add(name.title(), "2026 (Senior)", major, "Sigma Kappa", activities, other)

for name, hometown, major, activities in parse_sk_block(sk_2027_text):
    other = f"Hometown: {hometown}" if hometown else ""
    add(name.title(), "2027 (Junior)", major, "Sigma Kappa", activities, other)

with open('master_data.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(["Name","Class","Major","Affiliation","Interests","Other"])
    w.writerows(rows)

print(f"Wrote {len(rows)} rows")
for r in rows[:5]:
    print(r)
