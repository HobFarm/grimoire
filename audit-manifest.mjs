import { readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'

// Non-visual word detection heuristic
// A term is "visual" if it relates to: colors, lighting, textures, materials,
// body parts, clothing, animals, plants, architecture, photography, art styles,
// moods/atmosphere, composition, film/cinema, specific objects, poses, etc.
// A term is "non-visual" if it's a generic English word with no inherent visual quality.

const NON_VISUAL_INDICATORS = new Set([
  // Common non-visual abstract words, function words, generic nouns
  // We'll use a pattern-based approach instead of an exhaustive list
])

// Words that are clearly visual/artistic vocabulary
const VISUAL_PATTERNS = [
  // Colors and light
  /^(red|blue|green|yellow|orange|purple|violet|cyan|magenta|pink|white|black|gray|grey|gold|silver|bronze|copper|amber|crimson|scarlet|ivory|ebony|teal|indigo|lavender|maroon|navy|olive|coral|turquoise|beige|tan|khaki|mauve|fuchsia|chartreuse|periwinkle|burgundy|rust|sienna|umber|ochre|vermillion|cerulean)/i,
  /colou?r|hue|tint|shade|tone|saturation|chroma|luminan|bright|dark|dim|glow|shine|shimmer|glint|sparkl|radian|iridescen|opalescen|fluorescen|phosphorescen|neon|pastel|muted|vivid|vibrant/i,
  // Lighting
  /light|shadow|highlight|backl|sidelight|rimlight|ambient|diffuse|specular|reflect|refract|silhouett|chiaroscuro|rembrandt|bokeh|flare|bloom|ray|beam|spot|flood|strobe/i,
  // Photography/camera
  /photo|camera|lens|focal|aperture|shutter|iso|exposure|depth.of.field|dof|wide.angle|telephoto|macro|fisheye|tilt.shift|panoram|portrait|landscape|f\/?stop|35mm|50mm|85mm|zoom|prime/i,
  /shot|angle|frame|crop|composition|rule.of.thirds|leading.lines|negative.space|foreground|background|midground|vignette|grain|noise|blur|sharp|focus|bokeh|contrast/i,
  // Art/style
  /paint|sketch|draw|illustrat|render|digital|analog|watercolor|oil|acrylic|pastel|charcoal|pencil|ink|engraving|etching|lithograph|woodcut|fresco|mosaic|collage|montage/i,
  /impressionis|expressionis|cubis|surrealis|realis|minimalis|maximalis|art.deco|art.nouveau|baroque|gothic|renaissance|romantic|neoclassic|postmodern|contemporary|abstract|figurative|photorealis/i,
  /anime|manga|cel.shad|pixel|voxel|vector|raster|3d|cgi|concept.art|matte.paint|storyboard/i,
  // Texture/material/surface
  /texture|material|fabric|leather|silk|satin|velvet|denim|cotton|wool|linen|lace|mesh|knit|weave|fur|suede|corduroy|tweed/i,
  /metal|steel|iron|chrome|brass|aluminum|titanium|rusty|corroded|patina|oxidize/i,
  /wood|oak|pine|mahogany|walnut|birch|bamboo|teak|cedar|plywood|grain/i,
  /glass|crystal|ceramic|porcelain|marble|granite|stone|concrete|brick|slate|sandstone|limestone/i,
  /matte|glossy|shiny|polished|rough|smooth|bumpy|wrinkled|cracked|weathered|worn|distressed|aged/i,
  // Body/face/features
  /face|eye|nose|mouth|lip|ear|hair|brow|cheek|chin|jaw|forehead|temple|neck|shoulder|arm|hand|finger|leg|foot|torso|chest|waist|hip|skin|freckle|dimple|wrinkle|scar|tattoo|piercing/i,
  /muscl|slender|curvy|athletic|petite|tall|short|thin|stocky|broad|narrow/i,
  // Clothing
  /dress|shirt|blouse|jacket|coat|pants|skirt|gown|suit|tie|scarf|hat|boot|shoe|heel|sandal|glove|belt|vest|hoodie|sweater|cardigan|blazer|tunic|cape|cloak|robe|kimono|sari|corset|lingerie|bikini|swimsuit/i,
  /fabric|pattern|plaid|stripe|polka|floral|geometric|paisley|houndstooth|checkered|tartan/i,
  // Environment/nature
  /mountain|valley|river|lake|ocean|sea|beach|desert|forest|jungle|meadow|field|hill|cliff|canyon|cave|waterfall|volcano|island|glacier/i,
  /tree|flower|bush|vine|moss|fern|grass|leaf|petal|blossom|bloom|branch|trunk|root|seed|mushroom|cactus/i,
  /cloud|rain|snow|fog|mist|storm|thunder|lightning|rainbow|sunrise|sunset|dawn|dusk|twilight|moonlight|starlight/i,
  /sky|horizon|atmosphere|weather|season|spring|summer|autumn|winter|fall/i,
  // Architecture/interior
  /building|house|tower|castle|church|temple|palace|mansion|cabin|cottage|skyscraper|bridge|arch|column|pillar|dome|staircase|window|door|gate|wall|ceiling|floor|roof|balcony|terrace|corridor|hallway/i,
  /room|kitchen|bedroom|bathroom|studio|library|gallery|attic|basement|garden|courtyard|patio/i,
  /interior|exterior|facade|ornament|decor|furniture|chandelier|lamp|mirror|curtain|rug|carpet/i,
  // Animals
  /cat|dog|horse|bird|fish|snake|lizard|frog|turtle|rabbit|deer|wolf|bear|fox|lion|tiger|eagle|hawk|owl|raven|crow|swan|butterfly|dragonfly|spider|beetle|moth/i,
  /dragon|unicorn|phoenix|griffin|mermaid|centaur|minotaur|pegasus/i,
  // Film/cinema references
  /noir|cyberpunk|steampunk|dieselpunk|solarpunk|vaporwave|retrowave|synthwave|gothcore|cottagecore|dark.academia|light.academia|grunge|punk|emo|scene|kawaii|pastel.goth/i,
  /cinematic|dramatic|moody|ethereal|dreamy|surreal|fantastical|dystopian|utopian|apocalyptic|post.apocalyptic|futuristic|retro|vintage|antique|classical|medieval|victorian/i,
  // Mood/atmosphere
  /serene|tranquil|peaceful|calm|chaotic|intense|eerie|mysterious|haunting|melancholy|nostalgic|romantic|whimsical|playful|somber|grim|ominous|foreboding|majestic|grandiose|intimate|cozy|warm|cool|cold|hot/i,
  // Specific visual objects
  /sword|shield|crown|throne|mask|mirror|candle|lantern|torch|crystal|gem|jewel|ring|necklace|pendant|amulet|staff|wand|potion|scroll|book|key|clock|compass|telescope|microscope|globe/i,
  /car|motorcycle|bicycle|train|ship|boat|airplane|helicopter|rocket|spaceship/i,
  // Render/post-processing
  /render|post.process|filter|effect|overlay|blend|composite|hdr|ldr|tone.map|color.grad|lut|film.grain|chromatic|aberration|distortion|glitch|scan.line|crt|halftone|dither|pixel/i,
  // Pose/position
  /pose|posture|stance|sitting|standing|lying|leaning|kneeling|crouching|running|walking|jumping|dancing|fighting|reaching|pointing|holding|carrying|embracing|looking/i,
]

// Generic non-visual words: abstract concepts, function words, academic terms,
// everyday nouns with no visual quality
const NON_VISUAL_PATTERNS = [
  // Abstract concepts
  /^(the|a|an|and|or|but|if|then|else|not|is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|shall|should|can|could|may|might|must)$/i,
  // Generic verbs with no visual quality
  /^(think|know|believe|understand|remember|forget|learn|teach|explain|describe|suggest|recommend|require|need|want|wish|hope|fear|love|hate|like|dislike|prefer|agree|disagree|argue|debate|discuss|consider|assume|suppose|guess|wonder|doubt|deny|admit|claim|insist|maintain|assert|declare|announce|report|inform|notify|warn|advise|convince|persuade|encourage|motivate|inspire)$/i,
  // Academic/abstract nouns
  /^(theory|concept|idea|notion|principle|philosophy|ideology|paradigm|methodology|approach|strategy|policy|regulation|legislation|amendment|constitution|democracy|capitalism|socialism|communism|liberalism|conservatism|nationalism|globalism|empiricism|rationalism|pragmatism|utilitarianism)$/i,
  /^(analysis|synthesis|evaluation|assessment|measurement|calculation|computation|estimation|approximation|interpolation|extrapolation)$/i,
  // Business/office terms
  /^(management|marketing|accounting|finance|economics|investment|budget|revenue|profit|loss|salary|wage|tax|insurance|mortgage|dividend|equity|liability|asset|portfolio|stock|bond|fund|loan|credit|debit|invoice|receipt)$/i,
  /^(meeting|conference|seminar|workshop|presentation|report|document|memo|email|letter|proposal|contract|agreement|negotiation|arbitration)$/i,
  // Medical/scientific (non-visual)
  /^(diagnosis|prognosis|treatment|therapy|medication|prescription|symptom|syndrome|disease|disorder|infection|inflammation|allergy|immunity|vaccine|antibiotic|analgesic)$/i,
  // Legal terms
  /^(plaintiff|defendant|prosecutor|attorney|lawyer|judge|jury|verdict|sentence|appeal|statute|ordinance|jurisdiction|testimony|evidence|witness|indictment|arraignment|bail|parole|probation)$/i,
  // Computing (non-visual)
  /^(algorithm|database|software|hardware|program|function|variable|parameter|argument|boolean|integer|string|array|object|class|method|interface|protocol|server|client|network|bandwidth|latency|throughput|cache|buffer|stack|queue|heap|tree|graph|hash|sort|search|compile|execute|debug|deploy)$/i,
  // Generic relationship/social words
  /^(relationship|friendship|partnership|marriage|divorce|family|parent|child|sibling|cousin|uncle|aunt|nephew|niece|grandfather|grandmother|husband|wife|boyfriend|girlfriend)$/i,
  // Emotions (pure abstract, not visual moods)
  /^(happiness|sadness|anger|fear|surprise|disgust|contempt|jealousy|envy|pride|shame|guilt|regret|relief|gratitude|compassion|empathy|sympathy|apathy|indifference|boredom|excitement|anxiety|stress|depression)$/i,
  // Time/measurement (non-visual)
  /^(second|minute|hour|day|week|month|year|decade|century|millennium|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)$/i,
  // Food/cooking (unless visual)
  /^(recipe|ingredient|cooking|baking|frying|boiling|roasting|grilling|steaming|sauteing|braising|blanching|poaching|marinating|seasoning|spice|herb|salt|pepper|sugar|flour|butter|oil|vinegar)$/i,
  // Sports
  /^(football|basketball|baseball|soccer|tennis|golf|hockey|cricket|rugby|volleyball|badminton|squash|bowling|boxing|wrestling|karate|judo|fencing|archery|swimming|diving|surfing|skiing|snowboarding|skating|cycling|marathon|sprint|relay|hurdle|javelin|discus|shotput|decathlon|triathlon|pentathlon)$/i,
  // Music (non-visual)
  /^(melody|harmony|rhythm|tempo|beat|chord|scale|key|octave|note|pitch|tone|timbre|dynamics|crescendo|diminuendo|staccato|legato|allegro|andante|adagio|fortissimo|pianissimo|soprano|alto|tenor|bass|baritone)$/i,
  // Generic adjectives with no visual quality
  /^(good|bad|nice|great|fine|okay|important|significant|relevant|appropriate|suitable|adequate|sufficient|necessary|essential|critical|crucial|vital|fundamental|basic|simple|complex|difficult|easy|hard|soft|fast|slow|quick|early|late|old|new|young|big|small|large|little|long|short|high|low|wide|deep|thick|thin|heavy|light|strong|weak|rich|poor|cheap|expensive|free|busy|quiet|loud|clean|dirty|dry|wet|full|empty|open|closed|safe|dangerous|lucky|unlucky|happy|sad|angry|afraid|tired|hungry|thirsty|sick|healthy)$/i,
  // Completely abstract
  /^(truth|justice|freedom|liberty|equality|rights|duty|responsibility|obligation|authority|power|control|influence|dominance|submission|resistance|rebellion|revolution|reform|progress|development|growth|decline|collapse|success|failure|victory|defeat|achievement|accomplishment)$/i,
  // Filler/utility words that aren't visual
  /^(thing|stuff|something|anything|everything|nothing|someone|anyone|everyone|no.one|somewhere|anywhere|everywhere|nowhere|sometime|anytime|always|never|often|sometimes|usually|rarely|seldom|perhaps|maybe|probably|possibly|certainly|definitely|absolutely|completely|entirely|totally|exactly|precisely|approximately|roughly|basically|essentially|generally|specifically|particularly|especially|mainly|mostly|primarily|largely|partly|slightly|somewhat|rather|quite|very|really|truly|actually|literally|figuratively|metaphorically|symbolically|theoretically|practically|technically)$/i,
]

function isVisualTerm(term) {
  const t = term.trim().toLowerCase()
  if (!t || t.length < 2) return false

  // Multi-word phrases are more likely visual (scene descriptions, compound terms)
  const wordCount = t.split(/\s+/).length
  if (wordCount >= 3) return true  // "abandoned gothic cathedral" = visual

  // Check visual patterns first
  for (const pat of VISUAL_PATTERNS) {
    if (pat.test(t)) return true
  }

  // Check non-visual patterns
  for (const pat of NON_VISUAL_PATTERNS) {
    if (pat.test(t)) return false
  }

  // Heuristic: single short generic words are suspect
  // But proper nouns, technical terms, and unusual words are likely visual vocabulary
  if (wordCount === 1 && t.length <= 5) {
    // Very short single words: could be either. Default to uncertain -> visual
    // (benefit of the doubt for domain-specific short terms)
    return true
  }

  // Default: assume visual (benefit of the doubt for domain-specific lists)
  return true
}

function classifyTerm(term) {
  const t = term.trim()
  if (!t) return { term: t, visual: false, reason: 'empty' }

  const lower = t.toLowerCase()

  // Check non-visual patterns
  for (const pat of NON_VISUAL_PATTERNS) {
    if (pat.test(lower)) return { term: t, visual: false, reason: 'non-visual-pattern' }
  }

  // Check visual patterns
  for (const pat of VISUAL_PATTERNS) {
    if (pat.test(lower)) return { term: t, visual: true, reason: 'visual-pattern' }
  }

  // Multi-word: more likely visual
  const words = lower.split(/\s+/)
  if (words.length >= 3) return { term: t, visual: true, reason: 'multi-word' }

  // Single common English words that are abstract/non-visual
  // Use a curated list of the most obvious offenders
  const COMMON_NON_VISUAL = new Set([
    'about','above','after','again','against','along','also','although','among','another',
    'because','before','below','between','beyond','both','bring','came','come','could',
    'each','either','enough','even','every','few','find','first','from','gave','give',
    'goes','going','gone','gotten','however','into','just','keep','kept','last','least',
    'less','made','make','many','more','most','much','must','neither','next','none',
    'only','other','over','own','part','past','place','point','put','quite','same',
    'says','seem','self','shall','show','since','some','soon','still','such','sure',
    'take','than','that','their','them','then','there','these','they','this','those',
    'though','through','till','together','took','turn','under','until','upon','used',
    'using','very','want','well','went','what','when','where','which','while','whom',
    'whose','with','within','without','work','world','would','yet','your',
    // Common non-visual nouns
    'ability','absence','abundance','acceptance','access','accident','account','accuracy',
    'achievement','action','activity','addition','address','administration','advantage',
    'advice','affair','age','agency','agreement','aid','aim','alternative','amount',
    'answer','application','area','argument','arrangement','aspect','attempt','attention',
    'attitude','audience','average','awareness',
    'background','balance','bank','base','basis','beginning','behaviour','benefit','bit',
    'block','board','body','bottom','break','business',
    'capacity','case','cause','centre','century','certain','chance','change','chapter',
    'character','charge','check','choice','circle','claim','class','code','collection',
    'college','comment','commission','committee','communication','community','company',
    'comparison','competition','concern','condition','connection','consequence',
    'consideration','content','context','contract','contribution','control','convention',
    'conversation','copy','corner','cost','council','country','county','couple','course',
    'court','cover','crisis','criticism','culture','cup','current','customer',
    'damage','data','date','deal','death','debate','decision','defence','definition',
    'degree','demand','department','description','design','detail','development',
    'difference','difficulty','direction','director','discipline','discussion','disease',
    'display','distance','distinction','distribution','division','doctor','document',
    'doubt',
    'economy','education','effect','effort','element','emergency','emotion','emphasis',
    'employee','employer','employment','energy','engine','enterprise','enthusiasm',
    'entry','environment','episode','equipment','error','establishment','estate','event',
    'evidence','evolution','examination','example','exchange','exercise','existence',
    'expansion','expectation','expedition','expenditure','experience','experiment',
    'explanation','expression','extension','extent','extra','extreme',
    'fact','factor','failure','faith','fashion','fault','feature','feeling','fiction',
    'figure','finding','firm','focus','force','form','foundation','framework',
    'frequency','function','future',
    'gain','game','gap','generation','goal','government','grade','grant','ground',
    'group','growth','guide',
    'handling','head','health','heart','height','help','history','hold','household',
    'hypothesis',
    'identity','image','impact','implication','importance','impression','improvement',
    'incident','income','increase','independence','index','indication','individual',
    'industry','influence','information','initiative','innovation','input','inquiry',
    'instance','institution','instruction','insurance','intelligence','intention',
    'interaction','interest','interpretation','intervention','introduction','investigation',
    'involvement','issue','item',
    'job','journal','journey','judgment',
    'kind','knowledge',
    'labour','lack','language','launch','law','layer','lead','leadership','league',
    'leave','legislation','lesson','letter','level','liability','life','link','list',
    'literature','loan','logic','loss','lot',
    'machine','mail','majority','management','manner','mark','market','mass','master',
    'matter','maximum','meaning','measure','mechanism','media','member','membership',
    'memory','mention','message','method','mind','minimum','ministry','minority','minute',
    'mission','mistake','model','moment','money','month','motion','movement','murder',
    'museum',
    'name','nation','nature','negotiation','network','news','norm','notion','number',
    'object','objective','obligation','observation','occasion','offer','office','officer',
    'operation','opinion','opportunity','opposition','option','order','organisation',
    'origin','outcome','output','overall',
    'package','pair','panel','paper','paragraph','parliament','part','participant',
    'participation','partner','partnership','party','passage','past','path','pattern',
    'payment','penalty','pension','people','percentage','perception','performance',
    'period','permission','person','perspective','phase','phenomenon','philosophy',
    'phrase','plan','platform','player','pleasure','plenty','plus','pocket','point',
    'police','policy','politics','pollution','population','portion','position',
    'possibility','potential','poverty','practice','prayer','precedent','preference',
    'premise','preparation','presence','pressure','price','pride','principle','priority',
    'prison','privacy','probability','problem','procedure','process','product',
    'production','profession','professor','profit','programme','progress','project',
    'promise','promotion','proof','property','proportion','proposal','prospect',
    'protection','protest','provision','publication','purpose',
    'qualification','quality','quantity','quarter','question','quota',
    'race','range','rank','rate','ratio','reaction','reader','reality','reason',
    'recognition','recommendation','record','recovery','reduction','reference',
    'reflection','reform','region','register','regulation','rejection','relation',
    'release','religion','reluctance','remainder','remark','removal','repeat',
    'replacement','reply','report','representation','republic','reputation','request',
    'requirement','research','reserve','resident','resolution','resource','respect',
    'response','responsibility','rest','restoration','restriction','result','return',
    'revenue','review','revolution','right','risk','role','rule','ruling',
    'safety','sample','sanction','satisfaction','saving','scale','scenario','schedule',
    'scheme','school','science','scope','score','search','seat','section','sector',
    'security','selection','sense','sentence','sequence','series','service','session',
    'settlement','shape','share','shift','ship','side','sight','signal','significance',
    'silence','simulation','situation','skill','society','solution','sort','source',
    'space','span','speaker','specialist','species','speech','speed','spirit','split',
    'spokesman','spread','stability','staff','stage','stake','standard','start',
    'statement','station','status','step','stimulus','stock','stop','story','strain',
    'strategy','strength','stress','strike','structure','struggle','study','stuff',
    'style','subject','substance','success','suggestion','sum','summary','supply',
    'support','survey','survival','suspect','suspension','symbol','symptom','system',
    'target','task','team','technique','technology','telephone','tendency','term',
    'territory','test','text','theme','therapy','thought','threat','title','topic',
    'total','touch','tour','trace','track','trade','tradition','traffic','training',
    'transaction','transfer','transition','transport','travel','trend','trial','trouble',
    'trust','truth','turn','type',
    'understanding','union','unit','unity','university','use','user','utility',
    'validity','value','variation','variety','vehicle','version','victim','violation',
    'virtue','vision','visit','visitor','voice','volume','vote',
    'wage','warning','waste','wealth','weapon','welfare','width','will','winner','wish',
    'worker','worth',
    'zone',
    // Common verbs
    'accept','achieve','acquire','act','add','address','adjust','adopt','advance',
    'affect','afford','agree','aim','allow','alter','analyze','announce','anticipate',
    'appear','apply','appoint','appreciate','approach','approve','arise','arrange',
    'assess','assign','assist','assume','assure','attach','attain','attempt','attend',
    'attract','avoid',
    'bear','beat','become','begin','belong','bind','bite','blow','break','breed',
    'build','burn','burst','buy',
    'call','carry','catch','cause','cease','challenge','choose','cite','claim',
    'clarify','climb','cling','collapse','combine','commit','communicate','compare',
    'compel','compete','compile','complain','complete','comply','compose','comprise',
    'concentrate','conclude','conduct','confirm','confront','connect','consent',
    'conserve','consider','consist','constitute','construct','consult','consume',
    'contain','contemplate','contend','continue','contribute','convert','convince',
    'cooperate','cope','correct','correspond','count','create','criticize','cure',
    'damage','deal','decide','declare','decline','defeat','defend','define','delay',
    'deliver','demonstrate','deny','depend','deposit','derive','deserve','desire',
    'destroy','detect','determine','develop','devise','devote','differ','diminish',
    'direct','disappear','discover','discuss','dismiss','distinguish','distribute',
    'dominate','double','draft','drop','earn','eat','elect','eliminate','emerge',
    'emphasize','employ','enable','encounter','encourage','endure','enforce','engage',
    'enhance','enjoy','ensure','enter','equip','escape','establish','estimate',
    'evaluate','evolve','examine','exceed','exchange','exclude','execute','exercise',
    'exhibit','exist','expand','expect','experience','experiment','explain','exploit',
    'explore','expose','express','extend','extract',
    // Common adverbs
    'absolutely','accordingly','accurately','actually','additionally','adequately',
    'allegedly','also','altogether','apparently','approximately','automatically',
    'barely','basically','briefly','broadly','carefully','certainly','clearly',
    'closely','commonly','completely','considerably','consistently','constantly',
    'continuously','correctly','currently',
    'deeply','definitely','deliberately','directly',
    'effectively','efficiently','elsewhere','enormously','entirely','equally',
    'especially','essentially','eventually','evidently','exactly','excessively',
    'exclusively','explicitly','extensively','extremely',
    'fairly','finally','firmly','formally','formerly','frankly','freely','frequently',
    'fully','fundamentally',
    'generally','gently','genuinely','gradually','greatly',
    'hardly','heavily','hence','highly','honestly',
    'ideally','immediately','importantly','increasingly','independently','indirectly',
    'individually','inevitably','initially','instantly','instead','intensely',
    'ironically',
    'jointly','largely','lately','legitimately','likewise','literally','locally',
    'mainly','merely','moreover','mostly','naturally','nearly','necessarily',
    'nevertheless','normally','notably','obviously','occasionally','officially',
    'only','openly','originally','otherwise','overall',
    'partially','particularly','partly','perfectly','permanently','personally',
    'physically','politically','poorly','potentially','practically','precisely',
    'predominantly','previously','primarily','principally','privately','probably',
    'promptly','properly','purely',
    'rapidly','readily','really','reasonably','recently','regularly','relatively',
    'remarkably','repeatedly','reportedly','respectively','roughly',
    'sadly','scarcely','secondly','seemingly','separately','seriously','severely',
    'significantly','similarly','simply','simultaneously','sincerely','slightly',
    'solely','somehow','somewhat','specifically','steadily','strictly','strongly',
    'subsequently','substantially','successfully','suddenly','sufficiently',
    'supposedly','surely',
    'temporarily','thereby','thoroughly','thus','traditionally','truly','typically',
    'ultimately','undoubtedly','unfortunately','uniformly','uniquely','universally',
    'unlikely','usually','utterly',
    'vastly','virtually','wholly','widely','willingly',
  ])

  if (words.length === 1 && COMMON_NON_VISUAL.has(lower)) {
    return { term: t, visual: false, reason: 'common-non-visual' }
  }

  // Two-word phrases: check if both words are common non-visual
  if (words.length === 2) {
    const bothNonVisual = words.every(w => COMMON_NON_VISUAL.has(w))
    if (bothNonVisual) return { term: t, visual: false, reason: 'both-words-non-visual' }
  }

  // Default: assume visual
  return { term: t, visual: true, reason: 'default-visual' }
}

async function main() {
  const manifest = JSON.parse(await readFile('c:/Users/xkxxk/grimoire/triage-manifest.json', 'utf-8'))
  const sourceDir = manifest.source_directory
  const files = manifest.files

  const audit = []
  let flaggedCount = 0
  let flaggedLines = 0
  let missingFiles = 0

  for (const entry of files) {
    const filePath = path.join(sourceDir, entry.path)

    if (!existsSync(filePath)) {
      missingFiles++
      continue
    }

    let content
    try {
      content = await readFile(filePath, 'utf-8')
    } catch {
      missingFiles++
      continue
    }

    const allLines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0)
    const totalLines = allLines.length

    if (totalLines === 0) {
      audit.push({
        file: entry.path,
        totalLines: 0,
        sample: [],
        nonVisualCount: 0,
        nonVisualRatio: 0,
        flagged: false,
      })
      continue
    }

    // Sample 10 random lines (or all if fewer than 10)
    const sampleSize = Math.min(10, totalLines)
    const indices = new Set()
    while (indices.size < sampleSize) {
      indices.add(Math.floor(Math.random() * totalLines))
    }

    const sampleLines = Array.from(indices).sort((a, b) => a - b).map(i => allLines[i])

    // Classify each sample
    const classified = sampleLines.map(line => classifyTerm(line))
    const nonVisualCount = classified.filter(c => !c.visual).length
    const ratio = nonVisualCount / sampleSize
    const flagged = ratio >= 0.5

    if (flagged) {
      flaggedCount++
      flaggedLines += totalLines
    }

    audit.push({
      file: entry.path,
      totalLines,
      sample: classified.map(c => ({ term: c.term, visual: c.visual, reason: c.reason })),
      nonVisualCount,
      nonVisualRatio: Math.round(ratio * 100) / 100,
      flagged,
    })
  }

  // Sort: flagged first, then by nonVisualRatio descending
  audit.sort((a, b) => {
    if (a.flagged !== b.flagged) return b.flagged ? 1 : -1
    return b.nonVisualRatio - a.nonVisualRatio
  })

  await writeFile('c:/Users/xkxxk/grimoire/manifest-audit.json', JSON.stringify(audit, null, 2))

  // Summary
  const totalFilesAudited = audit.length
  const totalFlaggedLines = audit.filter(a => a.flagged).reduce((s, a) => s + a.totalLines, 0)
  const totalAllLines = audit.reduce((s, a) => s + a.totalLines, 0)

  console.log('\n=== MANIFEST AUDIT SUMMARY ===')
  console.log(`Files audited: ${totalFilesAudited}`)
  console.log(`Files missing: ${missingFiles}`)
  console.log(`Files flagged (50%+ non-visual): ${flaggedCount}`)
  console.log(`Lines in flagged files: ${totalFlaggedLines.toLocaleString()} / ${totalAllLines.toLocaleString()} total (${Math.round(totalFlaggedLines / totalAllLines * 100)}%)`)
  console.log(`\nTop 20 flagged files:`)

  const flaggedFiles = audit.filter(a => a.flagged)
  for (const f of flaggedFiles.slice(0, 20)) {
    const nonVisualTerms = f.sample.filter(s => !s.visual).map(s => s.term).join(', ')
    console.log(`  ${f.file} (${f.totalLines} lines, ${f.nonVisualRatio * 100}% non-visual)`)
    console.log(`    Non-visual sample: ${nonVisualTerms}`)
  }

  console.log(`\nFull report: manifest-audit.json`)
}

main().catch(console.error)
