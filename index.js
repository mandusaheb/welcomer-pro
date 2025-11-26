// Load environment variables (Railway-safe)
try {
  require('dotenv').config();
} catch (e) {
  // dotenv not required on Railway (environment variables are injected automatically)
}

// Required modules
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const fetch = require('node-fetch');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events
} = require('discord.js');

// Load variables from environment (NO DEFAULTS FOR SECURITY)
const TOKEN = process.env.TOKEN;
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID;
const OWNER_ID = process.env.OWNER_ID;

console.log("TOKEN Loaded:", !!TOKEN);
console.log("WELCOME_CHANNEL_ID Loaded:", !!WELCOME_CHANNEL_ID);
console.log("OWNER_ID Loaded:", !!OWNER_ID);

// Local paths
const LOCAL_BG_PATH = '/mnt/data/brave_screenshot_github.com.png';
const STORAGE_FILE = path.join(__dirname, 'engagement_counts.json');

// Create storage file if missing
if (!fs.existsSync(STORAGE_FILE)) {
  fs.writeFileSync(
    STORAGE_FILE,
    JSON.stringify(
      {
        choices: {
          "Discord Search": 0,
          "Friend Invite": 0,
          "Social Media": 0
        }
      },
      null,
      2
    )
  );
}

// Helper to read and write stats
function readCounts() {
  return JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8'));
}

function writeCounts(data) {
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2));
}

// Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

// Create blurred welcome image
async function makeWelcomeImage(memberTag) {
  const bg = await Jimp.read(LOCAL_BG_PATH);
  bg.cover(1200, 675);

  const blurred = bg.clone().blur(12).brightness(-0.05);

  const card = new Jimp(1000, 400, 0x00000088);

  const mask = new Jimp(card.bitmap.width, card.bitmap.height, 0x00000000);
  mask.scan(0, 0, mask.bitmap.width, mask.bitmap.height, function (x, y, idx) {
    const rx = x - mask.bitmap.width / 2;
    const ry = y - mask.bitmap.height / 2;
    const radius = Math.min(mask.bitmap.width, card.bitmap.height) / 2;
    const inside = Math.sqrt(rx * rx + ry * ry) < radius + 60;
    mask.bitmap.data[idx + 3] = inside ? 255 : 0;
  });

  const x = Math.floor((blurred.bitmap.width - card.bitmap.width) / 2);
  const y = Math.floor((blurred.bitmap.height - card.bitmap.height) / 2);

  blurred.composite(card, x, y);

  const fontTitle = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
  const fontSub = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
  const fontSmall = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);

  blurred.print(fontTitle, x + 30, y + 30, "🌌 Cosmic Gate");
  blurred.print(fontSub, x + 30, y + 120, `Welcome, ${memberTag}! A watcher of the stars greets you.`);
  blurred.print(fontSmall, x + 30, y + 360, "The stars remember your arrival");

  const outPath = path.join(__dirname, `welcome_${Date.now()}.png`);
  await blurred.quality(90).writeAsync(outPath);
  return outPath;
}

const ANIMATION_GIF_URL = "https://media.giphy.com/media/3o7aCSPqXE5C6T8tBC/giphy.gif";

// Build chart URL
function makeChartUrl(countsObj) {
  const labels = Object.keys(countsObj);
  const data = labels.map((l) => countsObj[l]);

  const chartConfig = {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Engagement sources",
          data,
          backgroundColor: "rgba(40, 150, 255, 0.8)"
        }
      ]
    }
  };

  return `https://quickchart.io/chart?c=${encodeURIComponent(
    JSON.stringify(chartConfig)
  )}&w=800&h=450&format=png`;
}

// When someone joins
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const channel = member.guild.channels.cache.get(WELCOME_CHANNEL_ID);
    if (!channel) return console.warn("Invalid WELCOME_CHANNEL_ID");

    const welcomeImagePath = await makeWelcomeImage(
      `${member.user.username}#${member.user.discriminator}`
    );

    const continueBtn = new ButtonBuilder()
      .setCustomId(`welcome_continue_${member.id}_${Date.now()}`)
      .setLabel("Continue")
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(continueBtn);

    await channel.send({
      content: `<@${member.id}>`,
      files: [welcomeImagePath],
      components: [row]()


