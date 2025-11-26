// Load environment variables (Railway-safe)
try {
  require('dotenv').config();
} catch (e) {
  // dotenv not required on Railway
}

// Required modules
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const fetch = require('node-fetch'); // v2
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

// Load variables from environment (NO DEFAULTS)
const TOKEN = process.env.TOKEN;
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID;
const OWNER_ID = process.env.OWNER_ID;

console.log('TOKEN Loaded:', !!TOKEN);
console.log('WELCOME_CHANNEL_ID Loaded:', !!WELCOME_CHANNEL_ID);
console.log('OWNER_ID Loaded:', !!OWNER_ID);

// Local assets & storage
const LOCAL_BG_PATH = '/mnt/data/brave_screenshot_github.com.png';
const STORAGE_FILE = path.join(__dirname, 'engagement_counts.json');

// Create storage file if missing
if (!fs.existsSync(STORAGE_FILE)) {
  fs.writeFileSync(
    STORAGE_FILE,
    JSON.stringify(
      {
        choices: {
          'Discord Search': 0,
          'Friend Invite': 0,
          'Social Media': 0
        }
      },
      null,
      2
    )
  );
}

// Helpers for stats
function readCounts() {
  return JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8'));
}
function writeCounts(data) {
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2));
}

// Create client
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

// Add a ready handler so you can see when the bot connected
client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag} (id: ${client.user.id})`);
});

// Build welcome image using Jimp
async function makeWelcomeImage(memberTag) {
  const bg = await Jimp.read(LOCAL_BG_PATH);
  bg.cover(1200, 675);

  const blurred = bg.clone().blur(12).brightness(-0.05);

  const card = new Jimp(1000, 400, 0x00000088);

  // simple rounded mask (soft)
  const mask = new Jimp(card.bitmap.width, card.bitmap.height, 0x00000000);
  mask.scan(0, 0, mask.bitmap.width, mask.bitmap.height, function (x, y, idx) {
    const rx = x - mask.bitmap.width / 2;
    const ry = y - mask.bitmap.height / 2;
    const radius = Math.min(mask.bitmap.width, mask.bitmap.height) / 2;
    const inside = Math.sqrt(rx * rx + ry * ry) < radius + 60;
    mask.bitmap.data[idx + 3] = inside ? 255 : 0;
  });

  const x = Math.floor((blurred.bitmap.width - card.bitmap.width) / 2);
  const y = Math.floor((blurred.bitmap.height - card.bitmap.height) / 2);

  blurred.composite(card, x, y);

  const fontTitle = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
  const fontSub = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
  const fontSmall = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);

  blurred.print(fontTitle, x + 30, y + 30, '🌌 Cosmic Gate');
  blurred.print(fontSub, x + 30, y + 120, `Welcome, ${memberTag}! A watcher of the stars greets you.`);
  blurred.print(fontSmall, x + 30, y + 360, 'The stars remember your arrival');

  const outPath = path.join(__dirname, `welcome_${Date.now()}.png`);
  await blurred.quality(90).writeAsync(outPath);
  return outPath;
}

const ANIMATION_GIF_URL = 'https://media.giphy.com/media/3o7aCSPqXE5C6T8tBC/giphy.gif';

// QuickChart builder
function makeChartUrl(countsObj) {
  const labels = Object.keys(countsObj);
  const data = labels.map((l) => countsObj[l]);
  const chartConfig = {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Engagement sources', data, backgroundColor: 'rgba(40,150,255,0.8)' }] }
  };
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=800&h=450&format=png`;
}

// On new member join
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const channel = member.guild.channels.cache.get(WELCOME_CHANNEL_ID);
    if (!channel) return console.warn('Invalid WELCOME_CHANNEL_ID');

    const welcomeImagePath = await makeWelcomeImage(`${member.user.username}#${member.user.discriminator}`);

    const continueBtn = new ButtonBuilder().setCustomId(`welcome_continue_${member.id}_${Date.now()}`).setLabel('Continue').setStyle(ButtonStyle.Primary);
    const row = new ActionRowBuilder().addComponents(continueBtn);

    await channel.send({ content: `<@${member.id}>`, files: [welcomeImagePath], components: [row] });

    setTimeout(() => { try { fs.unlinkSync(welcomeImagePath); } catch (e) {} }, 60_000);
  } catch (err) {
    console.error('Error in GuildMemberAdd handler:', err);
  }
});

// Interaction handling
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isButton()) return;

    const id = interaction.customId;

    if (id.startsWith('welcome_continue_')) {
      const parts = id.split('_');
      const targetMemberId = parts[2];
      if (interaction.user.id !== targetMemberId) return interaction.reply({ content: "This isn't for you.", ephemeral: true });

      await interaction.update({
        content: `<@${targetMemberId}>`,
        embeds: [new EmbedBuilder().setTitle('✨ A cosmic greeting...').setDescription('Hold on while the stars arrange themselves.').setImage(ANIMATION_GIF_URL)],
        components: []
      });

      setTimeout(async () => {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`choice_${targetMemberId}_Discord Search`).setLabel('Discord Search').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`choice_${targetMemberId}_Friend Invite`).setLabel('Friend Invite').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`choice_${targetMemberId}_Social Media`).setLabel('Social Media').setStyle(ButtonStyle.Primary)
        );

        try {
          await interaction.message.edit({ content: `<@${targetMemberId}>`, embeds: [new EmbedBuilder().setTitle('Tell us how you found us').setDescription('Choose one option below:')], components: [row] });
        } catch (e) {
          try { await interaction.followUp({ content: `<@${targetMemberId}>`, embeds: [new EmbedBuilder().setTitle('Tell us how you found us').setDescription('Choose one option below:')], components: [row] }); } catch (err) { console.error('Failed to present choices:', err); }
        }
      }, 2500);

      return;
    }

    if (id.startsWith('choice_')) {
      const match = id.match(/^choice_([^_]+)_(.+)$/);
      if (!match) return;
      const memberId = match[1];
      const chosenLabel = match[2];
      if (interaction.user.id !== memberId) return interaction.reply({ content: "This isn't for you.", ephemeral: true });

      const store = readCounts();
      if (!store.choices[chosenLabel]) store.choices[chosenLabel] = 0;
      store.choices[chosenLabel]++;
      writeCounts(store);

      await interaction.update({ content: `<@${memberId}>`, embeds: [new EmbedBuilder().setTitle('Thanks!').setDescription(`You chose: **${chosenLabel}**`)], components: [] });

      const url = makeChartUrl(store.choices);
      const owner = await client.users.fetch(OWNER_ID).catch(() => null);
      if (owner) {
        owner.send({ content: `New member chose **${chosenLabel}**`, embeds: [new EmbedBuilder().setTitle('Engagement Chart').setImage(url)] }).catch(() => {});
      }
      return;
    }
  } catch (e) {
    console.error('InteractionCreate handler error:', e);
    try { if (!interaction.deferred && !interaction.replied) await interaction.reply({ content: 'There was an error handling that action.', ephemeral: true }); } catch {}
  }
});

// Message ping & status command
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim().toLowerCase();
  if (content === '!ping') {
    try { await message.reply('Pong!'); } catch (e) {}
  }
  if (content === '!status') {
    try {
      await message.reply(`Bot: ${client.user ? client.user.tag : 'not ready'}, Guilds: ${client.guilds.cache.size}`);
    } catch (e) {}
  }
});

// Login
client.login(TOKEN).catch((err) => {
  console.error('Bot login failed. Check TOKEN in Railway → Variables.', err);
});



