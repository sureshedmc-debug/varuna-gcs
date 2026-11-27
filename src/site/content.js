// Words and media for the website. Everything here comes from the project
// itself: the film, the slides and the build. Edit freely.

export const M = (f) => `/site/${f}`

export const NAV = [
  ['Overview', '/#story'],
  ['Achievements', '/#achievements'],
  ['How it works', '/#how'],
  ['The boat', '/#boat'],
  ['Technology', '/#tech'],
  ['Gallery', '/#gallery'],
  ['Team', '/#team'],
  ['Try the AI', '/try'],
  ['Feedback', '/#feedback'],
]

export const STEPS = [
  {
    n: '01',
    kicker: 'Detect',
    title: 'The AI drone spots the plastic',
    body: 'Varuna, a quadcopter with a downward camera, flies over the river. An AI model running live on the video marks every floating bottle and bag it sees, with how sure it is.',
    video: 'detect',
    tag: 'Live drone feed · plastic bag 87%',
  },
  {
    n: '02',
    kicker: 'Locate',
    title: 'The Varuna app pins it on the map',
    body: 'The ground-control app turns each find into a GPS point on the river, plans the route section by section and keeps a record of every mission, detection and coordinate.',
    video: 'render-day',
    tag: 'Ground control · Direct Mission Plan',
  },
  {
    n: '03',
    kicker: 'Collect',
    title: 'The boat drives there and collects it',
    body: 'Nirmal Dhara Jalyan, a solar-powered autonomous boat, drives to each point by GPS. Close in, its own camera confirms the plastic, then the intake roller ramp lifts it out of the water into the bin.',
    video: 'boat',
    tag: 'Nirmal Dhara Jalyan · collecting',
  },
]

export const MACHINES = [
  {
    name: 'Varuna',
    role: 'AI aerial scout',
    img: 'p-drone-sky',
    specs: ['Quadcopter frame, 4 BLDC motors', 'Pixhawk flight controller', 'Raspberry Pi 3B+ on board', 'GPS module and camera', 'LiPo battery and propellers'],
  },
  {
    name: 'Nirmal Dhara Jalyan',
    role: 'Autonomous collector boat',
    img: 'p-boat-top',
    specs: ['Thermocol (EPS) floating body', 'Pixhawk autopilot running ArduRover', 'On-board Android phone: camera, GPS and link', 'BLDC motor with rudder steering', 'Intake roller ramp, collection bin, solar power'],
  },
  {
    name: 'VARUNA GCS',
    role: 'Ground-control app',
    img: 'p-render',
    specs: ['Plan missions on real river maps', 'Live drone video with AI detection', 'Drive and watch the boat', 'Face, fingerprint or Google sign-in', 'Every mission saved as records'],
  },
]

export const STACK = [
  'Python', 'FastAPI', 'React', 'Vite', 'Electron', 'YOLO', 'ONNX Runtime', 'OpenCV', 'pymavlink',
  'ArduCopter', 'ArduRover', 'Pixhawk', 'Raspberry Pi', 'Android', 'ESP32', 'NetBird', 'Three.js', 'Leaflet', 'face-api',
]

export const COMPARE = [
  ['Waste detection', 'Spotted by eye', 'AI-powered drone'],
  ['Navigation', 'Steered by hand', 'Autonomous GPS boat'],
  ['Waste collection', 'Nets and manual labour', 'Automated conveyor belt'],
  ['Power source', 'Fuel or muscle', 'Solar-powered'],
  ['Human involvement', 'High', 'Reduced'],
]

export const GALLERY = [
  { type: 'video', src: 'hero-1080', poster: 'hero-1080', title: 'First flight', sub: 'Varuna takes off over the school field', wide: true },
  { type: 'img', src: 'p-boat-top', title: 'Nirmal Dhara Jalyan', sub: 'The boat on its test pool' },
  { type: 'img', src: 'p-detect', title: 'What the drone sees', sub: 'The AI marks a plastic bag' },
  { type: 'video', src: 'boat-raw', poster: 'boat-raw', title: 'Into the water', sub: 'Launching the boat by hand' },
  { type: 'img', src: 'p-school', title: 'Field test', sub: 'Drone, pool and the team at work' },
  { type: 'img', src: 'p-night', title: 'The vision', sub: 'Drone and boat on a night river', wide: true },
  { type: 'video', src: 'detect', poster: 'detect', title: 'Live detection', sub: 'The camera feed in the app' },
  { type: 'img', src: 'p-boat', title: 'Built by hand', sub: 'Electronics inside the EPS hull' },
  { type: 'img', src: 'p-drone-sky', title: 'In the air', sub: 'Hovering above the trees' },
  { type: 'video', src: 'render-night', poster: 'render-night', title: 'Night patrol', sub: 'The app’s 3D river scene' },
  { type: 'video', src: 'boat-scoop', poster: 'boat-scoop', title: 'Plastic, collected', sub: 'The tricolour boat scoops a floating bag' },
  { type: 'img', src: 'award-exhibit', title: 'At the exhibition', sub: 'The VARUNA AI stand, DoE Science Centre No. 4' },
  { type: 'video', src: 'boat-night', poster: 'boat-night', title: 'After dark', sub: 'The boat with its lights on' },
  { type: 'img', src: 'award-trophy', title: 'Position I', sub: 'The 1st-place trophy' },
]

// How the boat works today. Taken from the boat's own code, settings and test
// notes (boat-vision branch), so keep it in step with the boat when it changes.
export const BOAT_LINKS = [
  { k: 'Ground station', name: 'VARUNA app', text: 'Runs the plastic-detection AI and the boat’s control software on the laptop, and shows the live camera and map.' },
  { k: 'On the boat', name: 'VARUNA Boat Link', text: 'An Android phone on board streams the camera, gives the autopilot its GPS position and carries every command to it over USB.' },
  { k: 'Autopilot', name: 'Pixhawk · ArduRover', text: 'Steers to each point and drives the motor, the rudder and the intake roller.' },
]
export const BOAT_LINK_VIA = ['NetBird · mobile data or Wi-Fi', 'USB cable']
export const BOAT_PARTS = [
  ['BLDC motor', 'Forward drive'],
  ['Rudder servo', 'Steering'],
  ['Roller ramp + bin', 'Collection'],
  ['FS-i6 transmitter', 'Manual control at any time'],
]

export const BOAT_RUN = [
  ['Points arrive', 'Each piece of plastic the drone found becomes a GPS point. The app sends the points to the boat, nearest first.'],
  ['Autopilot drives', 'ArduRover steers the boat to the next point, using the GPS position from the phone on board.'],
  ['Camera confirms', 'Close in, the boat’s own camera has to see real plastic: a plastic class only, in two frames running or once at 80% confidence. Birds, people, logs and reflections are refused.'],
  ['Measures and locks on', 'It works out the distance to the item from the camera’s height and angle, keeps tracking it as the hull rocks, and locks onto that one item.'],
  ['Approaches and scoops', 'The motor drives it forward. Inside scoop range the motor stops and the intake roller ramp lifts the plastic into the bin.'],
  ['Logs it, moves on', 'The app records the item as collected, with time and position, clears the target and sends the boat to the next point.'],
]

export const BOAT_SAFETY = [
  ['Never starts itself', 'A detection can never arm the boat or change its mode. Only the operator can.'],
  ['Stops when it loses sight', 'If the target disappears, the motor stops.'],
  ['Stops if the app goes quiet', 'A watchdog cuts the motor if the app stops sending, so a frozen picture can never hold it on.'],
  ['The operator wins', 'Disarm, STOP, pause or a flick of the transmitter switch stops the motor at once.'],
  ['Holds for wildlife', 'If a bird, a dog or a person is in front of it, the boat waits until the way is clear.'],
  ['Every limit adjustable', 'Confidence, distances and speeds are settings in the app, not fixed in the code.'],
]

// Newest first. Dates are when each change was finished.
export const BOAT_CHANGES = [
  { date: '19 Nov 2026', title: 'Moves only for confirmed plastic', text: 'The motor used to start for anything the camera reported. Now each item is checked for class, repeat sightings and distance before the boat moves, with the safety cut-outs above. Covered by 68 automated checks and tested end to end: detect, drive, scoop, collected.' },
  { date: '19 Nov 2026', title: 'Works from anywhere', text: 'The app finds the boat’s phone over NetBird first, so the live video, the AI and the scoop all work over mobile data, with no shared Wi-Fi needed.' },
  { date: '17 Nov 2026', title: 'A phone becomes the boat’s computer', text: 'The Raspberry Pi is replaced by an Android phone running the VARUNA Boat Link app: camera, GPS and the Pixhawk link in one device. An ESP32 Wi-Fi bridge is kept as a backup link.' },
  { date: '17 Nov 2026', title: 'Boat Ops screen', text: 'A new screen in the app for running the boat: live alerts, the boat’s status and a mini-map of the drone.' },
  { date: '6 Nov 2026', title: 'One motor, rudder steering', text: 'The drive was rebuilt around a single BLDC motor with a rudder servo for steering.' },
]
export const BOAT_NEXT = {
  title: 'Air-propeller drive',
  text: 'An air propeller above the water, so floating plastic and weeds can never wrap around it. It leads into the VARUNA AI Pod, an enclosed solar hull with room for water-quality sensors, now at the design stage.',
}

// The competition win. Wording follows the certificate and the trophy.
export const AWARD = {
  headline: 'First place at DoE Science Centre No. 4',
  event: 'Centre Level Science & Mathematics Exhibition 2026-27',
  org: 'Directorate of Education, Govt. of NCT of Delhi',
  centre: 'Science Centre No. 4, Gazipur, Delhi',
  category: 'Artificial Intelligence',
  venue: 'CM Shri School, Surajmal Vihar, Delhi',
  next: 'Selected for Skill Expo',
}

// Photos and a clip from the competition (opened big in the viewer).
export const AWARD_MEDIA = [
  { type: 'img', src: 'award-stage-photo', title: '1st place, on stage', sub: 'Receiving the trophy and certificates at Science Centre No. 4' },
  { type: 'img', src: 'award-trophy', title: 'The trophy', sub: 'Position I · Centre Level Science & Mathematics Exhibition 2026-27' },
  { type: 'img', src: 'award-certificate', title: 'The certificate', sub: 'Directorate of Education, Govt. of NCT of Delhi · Science Branch' },
  { type: 'img', src: 'award-exhibit', title: 'The VARUNA AI stand', sub: 'Drone, boat, app and trophies at the exhibition' },
]

// New footage of the tricolour collector boat.
export const BOAT_REELS = [
  { type: 'video', src: 'boat-scoop', poster: 'boat-scoop', tag: 'Collect', title: 'Scooping the plastic', sub: 'The front net lifts a floating bag out of the water' },
  { type: 'video', src: 'boat-drone', poster: 'boat-drone', tag: 'Team-up', title: 'Drone above, boat below', sub: 'Varuna flies over while the boat waits on the water' },
  { type: 'video', src: 'boat-night', poster: 'boat-night', tag: 'Night run', title: 'Lights on, after dark', sub: 'The tricolour hull with its LED strip glowing' },
]
export const MATCH_CLIP = [
  { type: 'video', src: 'app-match', poster: 'app-match', title: 'Waste matched', sub: 'The boat’s camera confirms it is the same plastic the drone found' },
]

export const TEAM = {
  school: 'Bhai Parmanand Vidya Mandir',
  theme: 'Environment & Sustainability',
  makers: [
    { name: 'Aditya Gautam', role: 'Creator of VARUNA AI · drone, boat and ground-control app', initials: 'AG' },
    { name: 'Samar Garg', role: 'Co-creator of VARUNA AI', initials: 'SG' },
  ],
}

// How to reach the team: a call to Aditya Gautam, for any enquiry or funding.
export const CONTACT = {
  name: 'Aditya Gautam',
  phone: '+91 78383 24455',
  tel: '+917838324455',
  whatsapp: `https://wa.me/917838324455?text=${encodeURIComponent('Hi Aditya, I saw VARUNA AI and would like to talk about ')}`,
  topics: ['Enquiries', 'Funding & sponsorship', 'Partnerships', 'Demos & media'],
}

// Plain questions and answers. Shown on the home page, written into the page's
// search data, and built into the static /about page (vite.config.js), so the
// three always say the same thing. Answers are plain text, no markup.
export const FAQ = [
  {
    q: 'Who created VARUNA AI?',
    a: 'VARUNA AI was created by Aditya Gautam and Samar Garg, students of Bhai Parmanand Vidya Mandir, for the theme Environment & Sustainability. They designed, wired, coded and tested the drone, the boat and the VARUNA GCS ground-control app themselves.',
  },
  {
    q: 'Has VARUNA AI won any awards?',
    a: 'Yes. VARUNA AI, by Aditya Gautam and Samar Garg, won first place (Position I) in Artificial Intelligence at the Centre Level Science & Mathematics Exhibition 2026-27 of the Directorate of Education, Govt. of NCT of Delhi, at Science Centre No. 4, Gazipur, held at CM Shri School, Surajmal Vihar. It was then selected for Skill Expo.',
  },
  {
    q: 'How can I contact the VARUNA AI team?',
    a: 'Call or WhatsApp Aditya Gautam, creator of VARUNA AI, directly on +91 78383 24455 for any enquiry, funding or sponsorship, partnership or demo.',
  },
  {
    q: 'What is VARUNA AI?',
    a: 'VARUNA AI is a river-cleaning system made of two machines: Varuna, an AI drone that flies over a river and finds floating plastic, and Nirmal Dhara Jalyan, a solar-powered autonomous boat that goes to that plastic and collects it.',
  },
  {
    q: 'What is VARUNA GCS?',
    a: 'VARUNA GCS is the ground-control app of VARUNA AI, made by Aditya Gautam and Samar Garg. It plans missions, shows the drone’s live camera with AI plastic detection, and sends the boat to collect what the drone finds. It runs in the browser, on Windows and on Android.',
  },
  {
    q: 'How does the Nirmal Dhara Jalyan boat collect plastic?',
    a: 'The boat drives to each plastic point by GPS under its Pixhawk autopilot. Close in, its own camera confirms the item is plastic and measures how far away it is, then the boat drives onto it and an intake roller ramp lifts it into the bin. An Android phone on board streams the camera, supplies the GPS position and links the autopilot to the VARUNA app over a secure connection, so it works over mobile data. The motor stops if the target is lost, if the app goes quiet or when the operator says so.',
  },
  {
    q: 'How does VARUNA AI find plastic?',
    a: 'An object-detection model trained on images of litter watches the drone’s camera and draws a box around each piece of plastic it sees, together with its GPS position. The detection runs on the device itself, so the video never has to leave it.',
  },
  {
    q: 'Can I try VARUNA AI?',
    a: 'Yes. The Try the AI page at varuna-gcs.vercel.app/try runs the same plastic detection on your own webcam, inside your browser. The VARUNA GCS app is free to download for Android and Windows once you sign in with a Google account.',
  },
]
