import csv
import re

rows = []

def add(name, cls, major, aff, interests, other):
    rows.append([name.strip(), cls, major.strip(), aff, interests.strip(), other.strip()])

# --- Alpha Chi Omega ---
# Only Class of 2027 available; no Class of 2026 (seniors) listed on site.
axo_2027 = """Chloe Baker
Serena Booth
Emma Cordts
Emma Cotter
Aya ElBably
Aleeza Fatima
Emma Fraioli
Sarina Gupta
Sydney Halbach
Zeynep Karaguzel
Erin Kim
Vy Le
Sylvie Levine
Ari McKeon
Sarah Mun
Sydney Nix
Yasmin Ochoa
Mei Powers
Aditi Rambhatla
Adley Turner"""
# NOTE: This is a placeholder; actual names pulled live below

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

with open('master_data.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(["Name","Class","Major","Affiliation","Interests","Other"])
    w.writerows(rows)

print(f"Wrote {len(rows)} rows so far")
