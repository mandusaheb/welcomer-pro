// index.js
// Two-page welcomer: immediate image -> Q1 (Friend / Discord / Other[modal]) -> Next -> Q2 (info) -> Confirm -> DM + chart
// Requirements: discord.js v14, node-fetch@2, jimp (optional if you change images), dotenv (optional)
// Env: TOKEN, WELCOME_CHANNEL_ID, OWNER_ID, (optional) WELCOME_ROLE_NAME

// Safe dotenv (won't crash on Railway)
try { require('dotenv').config(); } catch (e) {}

// Imports
const fs = require('fs');
const path = require('path');
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

// Environment (set these in Railway)
const TOKEN = process.env.TOKEN;
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID;
const OWNER_ID = process.env.OWNER_ID;
const WELCOME_ROLE_NAME = process.env.WELCOME_ROLE_NAME || 'FAMILY MEMBERS';

console.log('TOKEN Loaded:', !!TOKEN);
console.log('WELCOME_CHANNEL_ID Loaded:', !!WELCOME_CHANNEL_ID);
console.log('OWNER_ID Loaded:', !!OWNER_ID);
console.log('WELCOME_ROLE_NAME:', WELCOME_ROLE_NAME);

// Paths & storage
const LOCAL_IMAGE_PATH = '/mnt/data/Screenshot 2025-10-16 224418.png'; // the exact image you uploaded
const STORAGE_FILE = path.join(__dirname, 'engagement_counts.json');

// Ensure storage
if (!fs.existsSync(STORAGE_FILE)) {
  fs.writeFileSync(STORAGE_FILE, JSON.stringify({ choices: {} }, null, 2));
}
function readCounts(){ return JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8')); }
function writeCounts(d){ fs.writeFileSync(STORAGE_FILE, JSON.stringify(d, null, 2)); }

// In-memory session (short-lived)
const sessions = {}; // sessions[memberId] = { q1: null, q1raw:null, page:1, messageId, channelId }

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

// ready
client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag} (id: ${client.user.id})`);
});

// Helper: build professional QuickChart and return buffer
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

// Helper: send chart to owner (DM) or fallback to welcome channel
async function sendChartToOwner(countsObj, lastChoiceLabel, whoTag, guild) {
  try {
    const buffer = await buildChartBuffer(countsObj, lastChoiceLabel, whoTag);
    const att = new AttachmentBuilder(buffer, { name: 'engagement_chart.png' });
    try {
      const owner = await client.users.fetch(OWNER_ID);
      if (owner) {
        await owner.send({ content: `New answer recorded: **${lastChoiceLabel}** (by ${whoTag}). Latest engagement:`, files: [att] });
        return;
      }
    } catch (err) {
      console.warn('Could not DM owner, falling back to channel:', err);
    }
    // fallback
    try {
      const ch = guild.channels.cache.get(WELCOME_CHANNEL_ID);
      if (ch) await ch.send({ content: 'Latest engagement chart:', files: [att] });
    } catch (err) {
      console.error('Fallback chart post failed:', err);
    }
  } catch (err) {
    console.error('sendChartToOwner error:', err);
  }
}

// Build the page 1 embed + components (Next disabled unless answered)
function buildPage1Embed(memberId, selectedLabel = null) {
  const embed = new EmbedBuilder()
    .setTitle('Question 1 of 2 — Where did you find us?')
    .setDescription('Choose one option below. If you select **Other**, you will be asked to type where.')
    .setColor(0x0b69ff);

  // Buttons: Friend, Discord, Other (Other opens modal)
  const btnFriend = new ButtonBuilder().setCustomId(`q1_friend_${memberId}`).setLabel('Friend').setStyle(ButtonStyle.Secondary);
  const btnDiscord = new ButtonBuilder().setCustomId(`q1_discord_${memberId}`).setLabel('Discord').setStyle(ButtonStyle.Primary);
  const btnOther = new ButtonBuilder().setCustomId(`q1_other_${memberId}`).setLabel('Other').setStyle(ButtonStyle.Success);

  // Next — disabled if not selected
  const nextBtn = new ButtonBuilder().setCustomId(`q1_next_${memberId}`).setLabel('Next →').setStyle(ButtonStyle.Primary).setDisabled(!selectedLabel);

  const row1 = new ActionRowBuilder().addComponents(btnFriend, btnDiscord, btnOther);
  const row2 = new ActionRowBuilder().addComponents(nextBtn);

  return { embed, components: [row1, row2] };
}

// Build the page 2 embed + confirm button
function buildPage2Embed(memberId, q1Label) {
  const embed = new EmbedBuilder()
    .setTitle('Question 2 of 2 — About this channel')
    .setDescription(
      `This server focuses on **Cosmos Esports** — competitive gaming, events, and community.  
- 🎮 Tournaments & scrims  
- 🧠 Guides & coaching  
- 💬 Chill zone & team recruiting  

Your selection: **${q1Label}**. Click **Confirm** when you are ready.`
    )
    .setColor(0x0b69ff);

  const confirmBtn = new ButtonBuilder().setCustomId(`q2_confirm_${memberId}`).setLabel('Confirm').setStyle(ButtonStyle.Success);
  const row = new ActionRowBuilder().addComponents(confirmBtn);
  return { embed, components: [row] };
}

// Run welcome flow on a member-like object (member or fake for !testwelcome)
async function startWelcomeFor(memberLike) {
  try {
    const channel = memberLike.guild.channels.cache.get(WELCOME_CHANNEL_ID);
    if (!channel) {
      console.error('Invalid WELCOME_CHANNEL_ID or missing permissions:', WELCOME_CHANNEL_ID);
      return { ok: false, reason: 'invalid_channel' };
    }

    // 1) Send the provided image immediately
    let sentImageMsg;
    try {
      if (fs.existsSync(LOCAL_IMAGE_PATH)) {
        const attachment = new AttachmentBuilder(fs.readFileSync(LOCAL_IMAGE_PATH), { name: 'welcome.png' });
        sentImageMsg = await channel.send({ files: [attachment] });
      } else {
        // If image missing, send a fallback embed instead
        await channel.send({ embeds: [ new EmbedBuilder().setTitle('Welcome to Cosmos Esports').setDescription('Welcome!').setColor(0x0b0b0b) ] });
      }
    } catch (err) {
      console.error('Failed to send welcome image:', err);
    }

    // 2) Initialize session state
    sessions[memberLike.id] = { q1: null, q1raw: null, page: 1, messageId: null, channelId: channel.id };

    // 3) Send Page 1 (question embed + buttons)
    const { embed, components } = buildPage1Embed(memberLike.id, null);
    const sent = await channel.send({ content: `<@${memberLike.id}>`, embeds: [embed], components });
    sessions[memberLike.id].messageId = sent.id;
    return { ok: true, message: sent };
  } catch (err) {
    console.error('startWelcomeFor error:', err);
    return { ok: false, reason: 'error', error: err };
  }
}

// When a new guild member joins
client.on(Events.GuildMemberAdd, async (member) => {
  console.log('GuildMemberAdd:', member.user.tag, member.id);
  await startWelcomeFor(member);
});

// Interaction handling: buttons + modal submits
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Modal submit (Other)
    if (interaction.type === InteractionType.ModalSubmit) {
      const customId = interaction.customId; // format: modal_other_<memberId>
      const mMatch = customId.match(/^modal_other_(\d+)$/);
      if (mMatch) {
        const targetId = mMatch[1];
        if (interaction.user.id !== targetId) {
          await interaction.reply({ content: 'This modal is not for you.', ephemeral: true });
          return;
        }
        const otherField = interaction.fields.getTextInputValue('other_input'); // text input id below
        // store in session
        if (!sessions[targetId]) sessions[targetId] = { q1: null, q1raw: null, page: 1 };
        sessions[targetId].q1 = 'Other';
        sessions[targetId].q1raw = otherField;
        // enable Next by editing the original message components
        try {
          const ch = interaction.guild.channels.cache.get(sessions[targetId].channelId);
          if (ch && sessions[targetId].messageId) {
            const msg = await ch.messages.fetch(sessions[targetId].messageId).catch(()=>null);
            if (msg) {
              const { embed, components } = buildPage1Embed(targetId, 'Other');
              await msg.edit({ embeds: [embed], components });
            }
          }
        } catch (err) {
          console.warn('Failed to enable Next after modal:', err);
        }
        await interaction.reply({ content: 'Thanks — your answer has been recorded. Click Next to continue.', ephemeral: true });
        return;
      }
    }

    if (!interaction.isButton()) return;

    const id = interaction.customId;

    // q1 friend or discord or other
    const q1Match = id.match(/^q1_(friend|discord|other)_(\d+)$/);
    if (q1Match) {
      const choice = q1Match[1] === 'friend' ? 'Friend' : (q1Match[1] === 'discord' ? 'Discord' : 'Other');
      const memberId = q1Match[2];
      if (interaction.user.id !== memberId) {
        await interaction.reply({ content: "This question is for the new member only.", ephemeral: true });
        return;
      }

      // store session
      if (!sessions[memberId]) sessions[memberId] = { q1: null, q1raw: null, page: 1 };
      sessions[memberId].q1 = choice;
      if (choice !== 'Other') sessions[memberId].q1raw = choice;

      if (choice === 'Other') {
        // show modal to type other platform
        const modal = new ModalBuilder().setCustomId(`modal_other_${memberId}`).setTitle('Which platform did you find us on?');
        const input = new TextInputBuilder().setCustomId('other_input').setLabel('Type the platform (e.g. Instagram, Twitter, Reddit)').setStyle(TextInputStyle.Short).setPlaceholder('Instagram, Reddit, etc.').setRequired(true);
        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        await interaction.showModal(modal);
        return;
      } else {
        // enable Next by editing message
        try {
          const ch = interaction.guild.channels.cache.get(sessions[memberId].channelId);
          const msg = ch ? await ch.messages.fetch(sessions[memberId].messageId).catch(()=>null) : null;
          if (msg) {
            const { embed, components } = buildPage1Embed(memberId, sessions[memberId].q1);
            await msg.edit({ embeds: [embed], components });
          }
        } catch (err) {
          console.warn('Failed to update message after q1 choice:', err);
        }
        await interaction.reply({ content: `You selected **${sessions[memberId].q1}**. Click Next to continue.`, ephemeral: true });
        return;
      }
    }

    // Next button
    const nextMatch = id.match(/^q1_next_(\d+)$/);
    if (nextMatch) {
      const memberId = nextMatch[1];
      if (interaction.user.id !== memberId) {
        await interaction.reply({ content: 'This Next button is only for the joining member.', ephemeral: true });
        return;
      }
      // Ensure answered
      if (!sessions[memberId] || !sessions[memberId].q1) {
        await interaction.reply({ content: 'Please answer the question first.', ephemeral: true });
        return;
      }

      // Move to page 2: edit message to page 2 embed
      try {
        const ch = interaction.guild.channels.cache.get(sessions[memberId].channelId);
        const msg = ch ? await ch.messages.fetch(sessions[memberId].messageId).catch(()=>null) : null;
        if (msg) {
          const q1Label = sessions[memberId].q1raw || sessions[memberId].q1;
          const { embed, components } = buildPage2Embed(memberId, q1Label);
          await msg.edit({ embeds: [embed], components });
          sessions[memberId].page = 2;
        }
      } catch (err) {
        console.error('Failed to present page 2:', err);
      }
      await interaction.reply({ content: 'Moving to the next question...', ephemeral: true });
      return;
    }

    // Confirm on page 2
    const confirmMatch = id.match(/^q2_confirm_(\d+)$/);
    if (confirmMatch) {
      const memberId = confirmMatch[1];
      if (interaction.user.id !== memberId) {
        await interaction.reply({ content: 'This Confirm button is only for the joining member.', ephemeral: true });
        return;
      }

      // finalize: record answer -> JSON, send DM, update message to final
      const q1Label = sessions[memberId] ? (sessions[memberId].q1raw || sessions[memberId].q1) : 'Unknown';

      // update counts
      try {
        const store = readCounts();
        if (!store.choices[q1Label]) store.choices[q1Label] = 0;
        store.choices[q1Label]++;
        writeCounts(store);
      } catch (err) {
        console.error('Failed to update counts:', err);
      }

      // send a super-cool tech DM
      try {
        const dmEmbed = new EmbedBuilder()
          .setTitle('Welcome to Cosmos Esports — Mission Accepted 🚀')
          .setDescription(
            'Hey — welcome aboard! We just initialized your onboarding sequence and registered your response. ' +
            'We’re a fast, competitive community — expect events, coaching, and a squad-ready vibe.\n\n' +
            '**Quick tips:**\n• Use `#events` for tournaments\n• Use `#find-teammates` to recruit\n• Read `#rules` to stay safe\n\nSee you in the arena — Commander.\n`> connection established — enjoy the cosmos`'
          )
          .setColor(0x00ffcc)
          .setFooter({ text: 'Cosmos Esports • Dominate the cosmos' })
          .setTimestamp();

        // small animated GIF link for tech effect
        const gifUrl = 'https://media.giphy.com/media/3oEjI6SIIHBdRxXI40/giphy.gif';
        await interaction.user.send({ embeds: [dmEmbed], files: [], content: `✨ PERSONAL WELCOME — ${interaction.user.username}` }).catch(()=>{});
        // send second message with small tech gif (non-blocking)
        try { await interaction.user.send({ content: 'Welcome packet:', files: [gifUrl] }).catch(()=>{}); } catch {}
      } catch (err) {
        console.warn('Could not DM user (DMs might be closed):', err);
      }

      // edit original message to final small thanks embed
      try {
        const ch = interaction.guild.channels.cache.get(sessions[memberId].channelId);
        const msg = ch ? await ch.messages.fetch(sessions[memberId].messageId).catch(()=>null) : null;
        if (msg) {
          const doneEmbed = new EmbedBuilder().setTitle('Thanks!').setDescription(`You selected **${q1Label}**. Welcome!`).setColor(0x22bb33);
          await msg.edit({ content: `<@${memberId}>`, embeds: [doneEmbed], components: [] });
        }
      } catch (err) {
        console.warn('Failed to edit to final message:', err);
      }

      // send chart to owner
      try {
        const store = readCounts();
        await sendChartToOwner(store.choices, q1Label, interaction.user.tag, interaction.guild);
      } catch (err) {
        console.error('Failed sending chart to owner:', err);
      }

      // optionally assign role if WELCOME_ROLE_NAME exists (uncomment if desired)
      try {
        if (WELCOME_ROLE_NAME) {
          const guildMember = await interaction.guild.members.fetch(memberId).catch(()=>null);
          if (guildMember) {
            const role = interaction.guild.roles.cache.find(r => r.name === WELCOME_ROLE_NAME);
            if (role) {
              await guildMember.roles.add(role).catch(err => console.warn('Role add failed:', err));
            } else {
              console.warn('Role not found:', WELCOME_ROLE_NAME);
            }
          }
        }
      } catch (err) {
        console.warn('Role assignment exception:', err);
      }

      // cleanup session after short delay
      setTimeout(()=>{ delete sessions[memberId]; }, 5 * 60 * 1000);

      // reply ephemeral confirming finalization
      try { if (!interaction.replied) await interaction.reply({ content: 'Onboarding complete — welcome!', ephemeral: true }); } catch {}

      return;
    }

  } catch (err) {
    console.error('InteractionCreate error:', err);
    try { if (!interaction.replied) await interaction.reply({ content: 'There was an error handling that action.', ephemeral: true }); } catch {}
  }
});

// For convenience: allow manual testing via !testwelcome
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const c = message.content.trim().toLowerCase();
  if (c === '!ping') {
    try { await message.reply('Pong!'); } catch (e) {}
  }
  if (c === '!status') {
    try { await message.reply(`Bot: ${client.user ? client.user.tag : 'not ready'}, Guilds: ${client.guilds.cache.size}`); } catch (e) {}
  }
  if (c === '!testwelcome') {
    if (!message.guild) { message.reply('Use this inside a server channel.'); return; }
    try {
      const fake = { id: message.author.id, user: message.author, member: message.member, guild: message.guild };
      const res = await startWelcomeFor(fake); // small helper
      if (!res || !res.ok) {
        // fallback to startWelcomeFor (we implemented start in startWelcomeFor name earlier)
        const r = await startWelcomeFor(fake);
        if (!r.ok) message.reply('Test welcome failed (see logs).'); else message.reply('Test welcome sent to the welcome channel.');
      } else {
        message.reply('Test welcome sent to the welcome channel.');
      }
    } catch (err) {
      console.error('!testwelcome error:', err);
      try { message.reply('Test welcome failed (see logs).'); } catch {}
    }
  }
});

// Note: startWelcomeFor is identical to startWelcomeFor used earlier but we used startWelcomeFor name
// we must ensure that function exists - alias it to startWelcomeFor used above
async function startWelcomeFor(memberLike) { return await startWelcomeForCore(memberLike); }

// Implementation of core start function (alias - to avoid duplicate function name issue)
async function startWelcomeForCore(memberLike) {
  // reuse startWelcomeFor implemented above - but because of function naming duplication in this single-file, implement here
  try {
    const channel = memberLike.guild.channels.cache.get(WELCOME_CHANNEL_ID);
    if (!channel) {
      console.error('Invalid WELCOME_CHANNEL_ID or missing permissions:', WELCOME_CHANNEL_ID);
      return { ok: false, reason: 'invalid_channel' };
    }

    // send image
    try {
      if (fs.existsSync(LOCAL_IMAGE_PATH)) {
        const attachment = new AttachmentBuilder(fs.readFileSync(LOCAL_IMAGE_PATH), { name: 'welcome.png' });
        await channel.send({ files: [attachment] });
      } else {
        await channel.send({ embeds: [ new EmbedBuilder().setTitle('Welcome to Cosmos Esports').setDescription('Welcome!').setColor(0x0b0b0b) ] });
      }
    } catch (err) {
      console.error('Failed to send image in startWelcomeForCore:', err);
    }

    sessions[memberLike.id] = { q1: null, q1raw: null, page: 1, messageId: null, channelId: channel.id };

    const { embed, components } = buildPage1Embed(memberLike.id, null);
    const sent = await channel.send({ content: `<@${memberLike.id}>`, embeds: [embed], components });
    sessions[memberLike.id].messageId = sent.id;
    return { ok: true, message: sent };
  } catch (err) {
    console.error('startWelcomeForCore error:', err);
    return { ok: false, reason: 'error', error: err };
  }
}

// Login
if (!TOKEN) {
  console.error('Missing TOKEN environment variable. Set TOKEN in Railway variables and redeploy.');
} else {
  client.login(TOKEN).catch(err => {
    console.error('Login failed:', err);
  });
}


