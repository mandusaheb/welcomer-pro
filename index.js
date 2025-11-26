// index.js
// Cosmos Esports multi-page image-based welcomer (Style C, icons ON)
// Requires: discord.js@14, jimp, node-fetch@2
// Env vars required: TOKEN, WELCOME_CHANNEL_ID, OWNER_ID, (optional) WELCOME_ROLE_NAME

try { require('dotenv').config(); } catch (e) {}

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
  Events,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType,
  AttachmentBuilder
} = require('discord.js');

// ---------- CONFIG ----------
const TOKEN = process.env.TOKEN;
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID;
const OWNER_ID = process.env.OWNER_ID;
const WELCOME_ROLE_NAME = process.env.WELCOME_ROLE_NAME || 'FAMILY MEMBERS';

// Background image URL (your provided image)
const WELCOME_IMAGE_URL = 'https://img.sanishtech.com/u/450ba4d8410a77001bb7e1e4980af5cb.png';

// Small icon URLs for inside-image visuals (icons must support hotlink)
const ICONS = {
  friend: 'https://img.icons8.com/ios-filled/96/ffffff/user-group-man-man.png',
  discord: 'https://img.icons8.com/ios-glyphs/96/ffffff/discord.png',
  other: 'https://img.icons8.com/ios-filled/96/ffffff/internet.png'
};

// storage for counts
const STORAGE_FILE = path.join(__dirname, 'engagement_counts.json');
if (!fs.existsSync(STORAGE_FILE)) fs.writeFileSync(STORAGE_FILE, JSON.stringify({ choices: {} }, null, 2));
function readCounts(){ return JSON.parse(fs.readFileSync(STORAGE_FILE,'utf8')); }
function writeCounts(d){ fs.writeFileSync(STORAGE_FILE, JSON.stringify(d, null, 2)); }

// in-memory session state for interactive flow (short-lived)
const sessions = {}; // { memberId: { q1, q1raw, page, messageId, channelId } }

// ---------- Discord client ----------
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

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag} (${client.user.id})`);
});

// ---------- helper: build professional QuickChart ----------
async function buildChartBuffer(countsObj, lastChoiceLabel, whoTag) {
  const labels = Object.keys(countsObj);
  const data = labels.map(l => countsObj[l]);
  const chartConfig = {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'New members',
        data,
        backgroundColor: ['rgba(54,162,235,0.95)','rgba(75,192,192,0.95)','rgba(153,102,255,0.95)'],
        borderRadius: 8,
        barPercentage: 0.6
      }]
    },
    options: {
      layout:{ padding:12 },
      plugins:{
        title:{ display:true, text:'Where members discover the server', font:{ size:18 } },
        subtitle:{ display:true, text:`Last: ${lastChoiceLabel} — by ${whoTag}`, font:{ size:12 } },
        legend:{ display:false }
      },
      scales:{
        x:{ grid:{ display:false } },
        y:{ beginAtZero:true, grid:{ color:'rgba(255,255,255,0.06)' }, ticks:{ stepSize:1 } }
      },
      backgroundColor: '#0b0b0d'
    }
  };
  const qcUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=1000&h=500&format=png&version=3`;
  const res = await fetch(qcUrl);
  if (!res.ok) throw new Error(`Chart fetch failed: ${res.status}`);
  return await res.buffer();
}
async function sendChartToOwner(countsObj, lastChoiceLabel, whoTag, guild) {
  try {
    const buffer = await buildChartBuffer(countsObj, lastChoiceLabel, whoTag);
    const att = new AttachmentBuilder(buffer, { name: 'engagement_chart.png' });
    try {
      const owner = await client.users.fetch(OWNER_ID);
      if (owner) {
        await owner.send({ content: `New answer: **${lastChoiceLabel}** (by ${whoTag}) — latest engagement:`, files: [att] });
        return;
      }
    } catch (err) {
      console.warn('Could not DM owner; falling back to channel:', err);
    }
    if (guild) {
      const ch = guild.channels.cache.get(WELCOME_CHANNEL_ID);
      if (ch) await ch.send({ content: 'Latest engagement chart:', files: [att] });
    }
  } catch (err) {
    console.error('sendChartToOwner error:', err);
  }
}

// ---------- helper: draw a centered rounded panel onto the background ----------
async function renderPanelImage({ member, page = 1, selected = null, q1raw = null }) {
  // sizes
  const width = 1200, height = 675;
  const panelW = 920, panelH = 420;
  const panelX = Math.floor((width - panelW)/2);
  const panelY = Math.floor((height - panelH)/2);

  // load background
  let bg;
  try {
    const r = await fetch(WELCOME_IMAGE_URL);
    if (!r.ok) throw new Error('Background fetch failed');
    const buf = await r.buffer();
    bg = await Jimp.read(buf);
  } catch (err) {
    console.warn('Background load failed, using solid fallback:', err);
    bg = new Jimp(width, height, 0x111216FF);
  }
  bg.cover(width, height);

  // blurred backdrop for panel area (we'll create a blurred copy to composite)
  const blurred = bg.clone().blur(8).brightness(-0.06);

  // create transparent panel (slightly translucent) with rounded corners
  const panel = new Jimp(panelW, panelH, 0x00000080); // semi-transparent black
  // create rounded mask
  const mask = new Jimp(panelW, panelH, 0x00000000);
  const radius = 24;
  mask.scan(0,0,mask.bitmap.width, mask.bitmap.height, function(x,y,idx){
    // rounded rect check
    const rx = Math.max(0, Math.max(radius - x, x - (mask.bitmap.width - radius - 1)));
    const ry = Math.max(0, Math.max(radius - y, y - (mask.bitmap.height - radius - 1)));
    const dist = Math.sqrt(rx*rx + ry*ry);
    // if both rx/ry are zero then inside rectangular center -> fully opaque
    const inside = (rx <= 0 && ry <= 0) || (dist <= radius);
    mask.bitmap.data[idx+3] = inside ? 255 : 0;
  });
  panel.mask(mask, 0, 0);

  // composite blurred background then panel
  blurred.composite(panel, panelX, panelY);

  // draw a soft border glow around panel
  const border = new Jimp(panelW+8, panelH+8, 0x00000000);
  border.scan(0,0,border.bitmap.width,border.bitmap.height,function(x,y,idx){
    const cx = x - 4, cy = y - 4;
    // compute distance to panel edge
    const inRect = cx >= 0 && cx < panelW && cy >=0 && cy < panelH;
    if (!inRect) {
      // outer area - draw subtle bluish glow near edges
      const dx = Math.min(Math.abs(cx), Math.abs(cx - panelW + 1));
      const dy = Math.min(Math.abs(cy), Math.abs(cy - panelH + 1));
      const d = Math.sqrt(dx*dx + dy*dy);
      const alpha = Math.max(0, 60 - d); // small halo
      border.bitmap.data[idx+0] = 16;
      border.bitmap.data[idx+1] = 110;
      border.bitmap.data[idx+2] = 255;
      border.bitmap.data[idx+3] = alpha; // low alpha
    }
  });
  blurred.composite(border, panelX-4, panelY-4);

  // Load fonts (Jimp built-ins)
  let fontTitle, fontSub, fontSmall;
  try {
    fontTitle = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
    fontSub = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
    fontSmall = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
  } catch (err) {
    console.warn('Font load fail:', err);
  }

  // Draw page content onto blurred
  // Title at top-left of panel
  const textPaddingX = 40;
  const titleY = panelY + 28;
  blurred.print(fontTitle, panelX + textPaddingX, titleY, 'Where did you find us?');

  // Subtitle / page indicator top-right small
  blurred.print(fontSmall, panelX + panelW - 220, panelY + 36, 'Question 1 of 2');

  // draw option boxes inside panel (three boxes horizontally)
  const optW = 240, optH = 86;
  const gap = 28;
  const startX = panelX + textPaddingX;
  const optY = panelY + 120;

  const options = [
    { key: 'Friend', id: 'friend', label: 'Friend', icon: ICONS.friend },
    { key: 'Discord', id: 'discord', label: 'Discord', icon: ICONS.discord },
    { key: 'Other', id: 'other', label: 'Other', icon: ICONS.other }
  ];

  for (let i=0;i<options.length;i++){
    const o = options[i];
    const x = startX + i * (optW + gap);
    // box background
    const box = new Jimp(optW, optH, selected === o.key ? 0x214f9aff : 0x1f1f1fcc); // highlighted if selected
    // subtle border
    const borderColor = selected === o.key ? 0x55c0ffff : 0x000000ff;
    // draw border by drawing a slightly larger rect behind
    const boxBorder = new Jimp(optW+6, optH+6, borderColor);
    // rounded mask for box and border
    const boxMask = new Jimp(optW+6, optH+6, 0x00000000);
    const r2 = 16;
    boxMask.scan(0,0,boxMask.bitmap.width, boxMask.bitmap.height, function(px,py,idx){
      const dx = Math.min(px, boxMask.bitmap.width-1-px);
      const dy = Math.min(py, boxMask.bitmap.height-1-py);
      const inside = dx > 0 && dy > 0; // keep simple
      boxMask.bitmap.data[idx+3] = inside ? 255 : 0;
    });
    boxBorder.mask(boxMask, 0, 0);
    blurred.composite(boxBorder, x - 3, optY - 3);
    box.mask(boxMask, 0, 0);
    blurred.composite(box, x, optY);

    // load icon and paste
    try {
      const iconBuf = await (await fetch(o.icon)).buffer();
      const iconImg = await Jimp.read(iconBuf);
      iconImg.resize(48,48);
      blurred.composite(iconImg, x + 16, optY + Math.floor((optH-48)/2));
    } catch (err) {
      // ignore icon fetch error
    }

    // draw label text
    blurred.print(fontSub, x + 80, optY + Math.floor((optH-32)/2), o.label);
  }

  // draw Next button visual (we'll still use real Discord button for interaction)
  const nextText = selected ? 'Next →' : 'Next →';
  blurred.print(fontSmall, panelX + panelW - 160, panelY + panelH - 50, nextText);

  // If rendering page 2, replace content with the provided description text
  if (page === 2) {
    // draw header
    blurred.print(fontTitle, panelX + textPaddingX, titleY, 'About this channel');
    // draw the long provided description (we will wrap text manually)
    const longText = `🌌🕳️ WELCOME TO COSMOS ESPORTS - PAID SCRIMS 🕳️🌌\nWhere Legends Face Their Destiny in a Fair Galaxy... or Perish\n\n🚀⚠️ THE COSMOS CODE: READ BEFORE YOU LAUNCH ⚠️🚀\n💀🛑 THE COSMIC GATEKEEPER (PAYMENT RULES) 🛑💀\n🔴 PAYMENT FIRST, SLOT SECOND\nYour journey begins ONLY after we confirm your payment. No IOU's in the void. 🚫💸\n\n🔴 BOOKING PROCESS\nDM an @Orbit Controller → Make Payment → Send Proof → Receive Launch Codes. 🔐➡️💰➡️📩\n\n📱☠️ GALACTIC INTEGRITY (DEVICE & ANTI-CHEAT) ☠️📱\n🔴 MOBILE-ONLY UNIVERSE - NO PC/EMULATORS 🚫🖥️\n... (rules continue)`;
    // wrap and print using fontSmall in multiple lines inside panel body area
    const bodyX = panelX + 36;
    const bodyY = panelY + 100;
    const bodyW = panelW - 72;
    // naive wrap
    const words = longText.split(' ');
    let line = '', ycursor = bodyY;
    for (let w of words) {
      const test = line ? `${line} ${w}` : w;
      // measure using approximate char limit
      if (test.length > 60) {
        blurred.print(fontSmall, bodyX, ycursor, line);
        line = w;
        ycursor += 22;
      } else {
        line = test;
      }
    }
    if (line) blurred.print(fontSmall, bodyX, ycursor, line);
  }

  // small footer
  blurred.print(fontSmall, panelX + textPaddingX, panelY + panelH - 24, 'The stars remember your arrival');

  // return buffer
  const outBuffer = await blurred.getBufferAsync(Jimp.MIME_PNG);
  return outBuffer;
}

// ---------- Message builders (buttons) ----------
function buildQ1Components(memberId, nextEnabled=false) {
  const btnFriend = new ButtonBuilder().setCustomId(`q1_friend_${memberId}`).setLabel('Friend').setStyle(ButtonStyle.Secondary);
  const btnDiscord = new ButtonBuilder().setCustomId(`q1_discord_${memberId}`).setLabel('Discord').setStyle(ButtonStyle.Primary);
  const btnOther = new ButtonBuilder().setCustomId(`q1_other_${memberId}`).setLabel('Other').setStyle(ButtonStyle.Success);
  const nextBtn = new ButtonBuilder().setCustomId(`q1_next_${memberId}`).setLabel('Next →').setStyle(ButtonStyle.Secondary).setDisabled(!nextEnabled);
  return [ new ActionRowBuilder().addComponents(btnFriend, btnDiscord, btnOther), new ActionRowBuilder().addComponents(nextBtn) ];
}
function buildQ2Components(memberId) {
  const confirm = new ButtonBuilder().setCustomId(`q2_confirm_${memberId}`).setLabel('Confirm').setStyle(ButtonStyle.Success);
  return [ new ActionRowBuilder().addComponents(confirm) ];
}

// ---------- Start welcome flow ----------
async function startWelcomeFor(memberLike) {
  try {
    const channel = memberLike.guild.channels.cache.get(WELCOME_CHANNEL_ID);
    if (!channel) {
      console.error('Invalid WELCOME_CHANNEL_ID or missing permissions.');
      return { ok:false };
    }

    sessions[memberLike.id] = { q1: null, q1raw: null, page: 1, messageId: null, channelId: channel.id };

    // render page1 image (no selection)
    const buffer = await renderPanelImage({ member: memberLike, page: 1, selected: null });
    const attachment = new AttachmentBuilder(buffer, { name: 'welcome_panel.png' });

    const comps = buildQ1Components(memberLike.id, false);
    const sent = await channel.send({ content: `<@${memberLike.id}>`, files: [attachment], components: comps });
    sessions[memberLike.id].messageId = sent.id;
    return { ok:true, message: sent };
  } catch (err) {
    console.error('startWelcomeFor error:', err);
    return { ok:false, error:err };
  }
}

// ---------- Interaction handling ----------
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // modal submit for Other
    if (interaction.type === InteractionType.ModalSubmit) {
      const m = interaction.customId.match(/^modal_other_(\d+)$/);
      if (m) {
        const memberId = m[1];
        if (interaction.user.id !== memberId) {
          await interaction.reply({ content: 'This modal is not for you.', ephemeral: true });
          return;
        }
        const text = interaction.fields.getTextInputValue('other_input');
        sessions[memberId] = sessions[memberId] || { q1:null, q1raw:null, page:1 };
        sessions[memberId].q1 = 'Other';
        sessions[memberId].q1raw = text;

        // regenerate image with highlighted selection
        try {
          const buffer = await renderPanelImage({ member: interaction.user, page:1, selected: 'Other', q1raw: text });
          const att = new AttachmentBuilder(buffer, { name: 'welcome_panel.png' });
          const ch = interaction.guild.channels.cache.get(sessions[memberId].channelId);
          const msg = ch ? await ch.messages.fetch(sessions[memberId].messageId).catch(()=>null) : null;
          if (msg) {
            await msg.edit({ content: `<@${memberId}>`, files: [att], embeds: [], components: buildQ1Components(memberId, true) });
          }
        } catch (err) { console.warn('Failed to update image after modal:', err); }

        await interaction.reply({ content: 'Recorded. Click Next to continue.', ephemeral: true });
        return;
      }
    }

    if (!interaction.isButton()) return;
    const id = interaction.customId;

    // Q1 choices
    const q1 = id.match(/^q1_(friend|discord|other)_(\d+)$/);
    if (q1) {
      const choice = q1[1] === 'friend' ? 'Friend' : (q1[1] === 'discord' ? 'Discord' : 'Other');
      const memberId = q1[2];
      if (interaction.user.id !== memberId) {
        await interaction.reply({ content:'This is for the joining member only.', ephemeral: true });
        return;
      }
      sessions[memberId] = sessions[memberId] || { q1:null, q1raw:null, page:1 };

      if (choice === 'Other') {
        // show modal
        const modal = new ModalBuilder().setCustomId(`modal_other_${memberId}`).setTitle('Which platform did you find us on?');
        const input = new TextInputBuilder().setCustomId('other_input').setLabel('Platform (e.g. Instagram, Reddit)').setStyle(TextInputStyle.Short).setRequired(true);
        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        await interaction.showModal(modal);
        return;
      } else {
        sessions[memberId].q1 = choice;
        sessions[memberId].q1raw = choice;
        // regenerate image with selection highlighted and enable Next
        try {
          const buffer = await renderPanelImage({ member: interaction.user, page:1, selected: choice });
          const att = new AttachmentBuilder(buffer, { name: 'welcome_panel.png' });
          const ch = interaction.guild.channels.cache.get(sessions[memberId].channelId);
          const msg = ch ? await ch.messages.fetch(sessions[memberId].messageId).catch(()=>null) : null;
          if (msg) await msg.edit({ content: `<@${memberId}>`, files: [att], embeds: [], components: buildQ1Components(memberId, true) });
        } catch (err) { console.warn('Failed to update image after Q1:', err); }
        await interaction.reply({ content: `Selected ${choice}. Click Next to continue.`, ephemeral: true });
        return;
      }
    }

    // Next
    const next = id.match(/^q1_next_(\d+)$/);
    if (next) {
      const memberId = next[1];
      if (interaction.user.id !== memberId) {
        await interaction.reply({ content: 'This Next button is only for the joining member.', ephemeral: true });
        return;
      }
      if (!sessions[memberId] || !sessions[memberId].q1) {
        await interaction.reply({ content: 'Please answer the question first.', ephemeral: true });
        return;
      }
      // render page 2 image (description)
      try {
        const buffer = await renderPanelImage({ member: interaction.user, page:2, selected: sessions[memberId].q1, q1raw: sessions[memberId].q1raw });
        const att = new AttachmentBuilder(buffer, { name: 'welcome_panel.png' });
        const ch = interaction.guild.channels.cache.get(sessions[memberId].channelId);
        const msg = ch ? await ch.messages.fetch(sessions[memberId].messageId).catch(()=>null) : null;
        if (msg) await msg.edit({ content: `<@${memberId}>`, files: [att], embeds: [], components: buildQ2Components(memberId) });
        sessions[memberId].page = 2;
      } catch (err) {
        console.error('Failed to render page2:', err);
      }
      await interaction.reply({ content: 'Moved to page 2.', ephemeral: true });
      return;
    }

    // Confirm
    const confirm = id.match(/^q2_confirm_(\d+)$/);
    if (confirm) {
      const memberId = confirm[1];
      if (interaction.user.id !== memberId) {
        await interaction.reply({ content: 'This Confirm is only for the joining member.', ephemeral: true });
        return;
      }
      const q1Label = sessions[memberId] ? (sessions[memberId].q1raw || sessions[memberId].q1) : 'Unknown';

      // update counts
      try {
        const store = readCounts();
        if (!store.choices[q1Label]) store.choices[q1Label] = 0;
        store.choices[q1Label]++;
        writeCounts(store);
      } catch (err) { console.error('Counts update failed:', err); }

      // send the super-cool tech DM
      try {
        const dm = new EmbedBuilder()
          .setTitle('Welcome to Cosmos Esports — Mission Accepted 🚀')
          .setDescription(
            `Commander ${interaction.user.username}, your onboarding is complete.\n\n` +
            'You have been registered for paid scrims info. Read the rules in the server and contact an @Orbit Controller to book a slot.\n\n' +
            '`> connection established — enjoy the cosmos`'
          )
          .setColor(0x00ffcc)
          .setFooter({ text: 'Cosmos Esports • Dominate the cosmos' })
          .setTimestamp();
        await interaction.user.send({ embeds: [dm] }).catch(()=>{});
      } catch (err) { console.warn('Could not DM user:', err); }

      // edit original message to final small thanks embed
      try {
        const ch = interaction.guild.channels.cache.get(sessions[memberId].channelId);
        const msg = ch ? await ch.messages.fetch(sessions[memberId].messageId).catch(()=>null) : null;
        if (msg) {
          const done = new EmbedBuilder().setTitle('Thanks!').setDescription(`You selected **${q1Label}** — welcome!`).setColor(0x22bb33);
          await msg.edit({ content: `<@${memberId}>`, embeds: [done], components: [] });
        }
      } catch (err) { console.warn('Failed to edit final message:', err); }

      // send chart to owner
      try {
        const store = readCounts();
        await sendChartToOwner(store.choices, q1Label, interaction.user.tag, interaction.guild);
      } catch (err) { console.error('Chart send failed:', err); }

      // assign role if exists
      try {
        if (WELCOME_ROLE_NAME) {
          const guildMember = await interaction.guild.members.fetch(memberId).catch(()=>null);
          if (guildMember) {
            const role = interaction.guild.roles.cache.find(r => r.name === WELCOME_ROLE_NAME);
            if (role) await guildMember.roles.add(role).catch(err => console.warn('Role add failed:', err));
            else console.warn('Role not found:', WELCOME_ROLE_NAME);
          }
        }
      } catch (err) { console.warn('Role assignment error:', err); }

      // cleanup
      setTimeout(()=>{ delete sessions[memberId]; }, 5*60*1000);
      try { if (!interaction.replied) await interaction.reply({ content: 'Onboarding complete — welcome!', ephemeral: true }); } catch {}
      return;
    }

  } catch (err) {
    console.error('InteractionCreate error:', err);
    try { if (!interaction.replied) await interaction.reply({ content: 'Error handling action.', ephemeral: true }); } catch {}
  }
});

// ---------- commands for testing ----------
client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;
  const c = msg.content.trim().toLowerCase();
  if (c === '!ping') return msg.reply('Pong!');
  if (c === '!status') return msg.reply(`Bot: ${client.user ? client.user.tag : 'not ready'}, Guilds: ${client.guilds.cache.size}`);
  if (c === '!testwelcome') {
    if (!msg.guild) return msg.reply('Use this inside a server channel.');
    try {
      const fake = { id: msg.author.id, user: msg.author, member: msg.member, guild: msg.guild };
      const res = await startWelcomeTest(fake);
      if (!res.ok) msg.reply('Test welcome failed (check logs).'); else msg.reply('Test welcome sent to the welcome channel.');
    } catch (err) {
      console.error('!testwelcome error:', err);
      try { msg.reply('Test welcome failed (see logs).'); } catch {}
    }
  }
});

// wrapper to avoid confusion in naming
async function startWelcomeTest(memberLike) { return await startWelcomeFor(memberLike); }

// ---------- on guild member join ----------
client.on(Events.GuildMemberAdd, async (member) => {
  console.log('GuildMemberAdd:', member.user.tag, member.id);
  try { await startWelcomeFor(member); } catch (err) { console.error('startWelcomeFor failed:', err); }
});

// ---------- startWelcomeFor (main) ----------
async function startWelcomeFor(memberLike) {
  return await startWelcomeForCore(memberLike);
}
async function startWelcomeForCore(memberLike) {
  try {
    const channel = memberLike.guild.channels.cache.get(WELCOME_CHANNEL_ID);
    if (!channel) {
      console.error('Invalid WELCOME_CHANNEL_ID or missing perms.');
      return { ok:false };
    }
    sessions[memberLike.id] = { q1:null, q1raw:null, page:1, messageId:null, channelId: channel.id };
    const buffer = await renderPanelImage({ member: memberLike, page: 1, selected: null });
    const att = new AttachmentBuilder(buffer, { name: 'welcome_panel.png' });
    const comps = buildQ1Components(memberLike.id, false);
    const sent = await channel.send({ content: `<@${memberLike.id}>`, files: [att], components: comps });
    sessions[memberLike.id].messageId = sent.id;
    return { ok:true, message: sent };
  } catch (err) {
    console.error('startWelcomeForCore error:', err);
    return { ok:false, error:err };
  }
}

// ---------- login ----------
if (!TOKEN) {
  console.error('Missing TOKEN env var. Set TOKEN in Railway and redeploy.');
} else {
  client.login(TOKEN).catch(err => console.error('Login failed:', err));
}
