-- Library content seed: all 13 items from src/content/items.json,
-- with rich-text bodies from src/content/bodies/<slug>.json where available.
-- Generated from those JSON files; IDs, slugs, categories, languages,
-- metadata and text are preserved unchanged. Columns follow db/schema.sql.
--
-- Requires migrations 0001 (tables) and 0002 (languages and categories),
-- because every item references a category and a language.
--
-- Idempotent: INSERT OR IGNORE skips items whose id or slug already exists,
-- so running this again inserts nothing and never overwrites edited items.
--
-- Field notes:
--   tags_json / links_json : JSON arrays ('[]' when an item has no links)
--   body_json              : compact JSON of the body file ({"blocks": [...]})
--   file_url               : relative to the site root (e.g. documents/x.pdf)

-- article: how-a-rainbow-forms
INSERT OR IGNORE INTO items (id, slug, type, category_id, language, title, description, tags_json, links_json, added_at, updated_at, body_json, reading_minutes, file_url, page_count, video_url, url) VALUES (
  'itm_rainbow',
  'how-a-rainbow-forms',
  'article',
  'cat_science',
  'ar',
  'كيف يتشكّل قوس قزح؟',
  'لماذا نرى قوس قزح دائمًا في الجهة المقابلة للشمس، ولماذا يكون على شكل قوس؟ شرح مبسّط للانكسار والتشتّت والانعكاس داخل قطرات المطر.',
  '["rainbow","light","physics","optics","قوس قزح","ضوء","فيزياء"]',
  '[{"label":"قوس قزح على ويكيبيديا","url":"https://ar.wikipedia.org/wiki/%D9%82%D9%88%D8%B3_%D9%82%D8%B2%D8%AD"}]',
  '2026-11-02',
  '2026-11-02',
  '{"blocks":[{"id":"b01","type":"paragraph","text":"يظهر قوس قزح عندما تكون الشمس خلفك والمطر أمامك. وهذا ليس صدفة: فكل قطرة مطر تعمل كمنشور صغير يكسر ضوء الشمس ويعكسه نحو عينيك بزاوية محددة."},{"id":"b02","type":"heading","level":2,"text":"ثلاث خطوات داخل كل قطرة"},{"id":"b03","type":"list","ordered":true,"items":["**الانكسار:** عندما يدخل ضوء الشمس إلى القطرة ينتقل من الهواء إلى الماء، فيتغيّر اتجاهه.","**الانعكاس:** يرتدّ الضوء عن الجدار الخلفي للقطرة.","**الانكسار مرة ثانية:** عند خروج الضوء من القطرة إلى الهواء ينحرف مرة أخرى."]},{"id":"b04","type":"paragraph","text":"لا تنكسر جميع الألوان بالقدر نفسه، لأن معامل انكسار الماء يختلف قليلًا باختلاف طول الموجة. ينحرف الضوء البنفسجي أكثر من الأحمر، فتنفصل الألوان بعضها عن بعض، وتُسمّى هذه الظاهرة **التشتّت**."},{"id":"b05","type":"heading","level":2,"text":"لماذا يكون على شكل قوس؟"},{"id":"b06","type":"paragraph","text":"يخرج الضوء الأكثر سطوعًا من القطرات بزاوية تقارب ٤٢ درجة بالنسبة إلى الخط الممتد من الشمس مرورًا برأسك. كل القطرات التي تقع على هذه الزاوية بالنسبة إلى عينك ترسل إليك اللون نفسه، ومجموعها يشكّل دائرة مركزها النقطة المقابلة تمامًا للشمس. نرى عادةً جزءًا من هذه الدائرة فقط لأن الأرض تحجب بقيّتها، أما من الطائرة فقد تظهر الدائرة كاملة."},{"id":"b07","type":"paragraph","text":"ولهذا السبب أيضًا لا يمكنك الوصول إلى طرف قوس قزح: فهو ليس جسمًا في مكان محدد، بل زاوية بين الشمس وعينك والقطرات. وكل شخص يرى قوسه الخاص المكوّن من قطرات مختلفة."},{"id":"b08","type":"heading","level":2,"text":"القوس الثانوي"},{"id":"b09","type":"paragraph","text":"أحيانًا يظهر قوس ثانٍ أخفت فوق الأول، بزاوية تقارب ٥١ درجة. ينتج عن انعكاسين داخل القطرة بدل انعكاس واحد، ولذلك تكون ألوانه معكوسة: الأحمر في الداخل والبنفسجي في الخارج. أما المنطقة بين القوسين فتبدو أغمق من السماء حولها، وتُعرف بـ«شريط ألكسندر»."},{"id":"b10","type":"quote","text":"قوس قزح ليس شيئًا معلّقًا في السماء، بل موعد بين الشمس وقطرات المطر وعينك."},{"id":"b11","type":"details","summary":"للمهتمين: من أين جاءت زاوية ٤٢ درجة؟","blocks":[{"id":"b11a","type":"paragraph","text":"عند تتبّع أشعة كثيرة تدخل القطرة على مسافات مختلفة من مركزها، نجد أن زاوية خروجها لا تتجاوز حدًّا أقصى يقارب ٤٢ درجة للضوء الأحمر، وتتجمّع حول هذا الحد أشعة كثيرة فيبدو أكثر سطوعًا. حسب رينيه ديكارت هذه الزاوية عام ١٦٣٧، ثم فسّر إسحاق نيوتن لاحقًا سبب انفصال الألوان."}]}]}',
  2,
  NULL,
  NULL,
  NULL,
  NULL
);

-- youtube: but-what-is-a-neural-network
INSERT OR IGNORE INTO items (id, slug, type, category_id, language, title, description, tags_json, links_json, added_at, updated_at, body_json, reading_minutes, file_url, page_count, video_url, url) VALUES (
  'itm_neural_network_video',
  'but-what-is-a-neural-network',
  'youtube',
  'cat_science',
  'en',
  'But What Is a Neural Network?',
  '3Blue1Brown''s visual introduction to how a neural network recognises handwritten digits, built up from neurons, layers, weights and biases.',
  '["neural networks","machine learning","deep learning","3Blue1Brown","AI"]',
  '[{"label":"3Blue1Brown","url":"https://www.3blue1brown.com/"}]',
  '2026-10-28',
  '2026-10-28',
  '{"blocks":[{"id":"b01","type":"heading","level":2,"text":"Why it is worth watching"},{"id":"b02","type":"paragraph","text":"Most introductions to neural networks start with equations. This one starts with a concrete problem, recognising handwritten digits, and only introduces **neurons**, **weights** and **biases** when you already know why they are needed."},{"id":"b03","type":"list","ordered":false,"items":["A neuron is just a number between 0 and 1, its *activation*.","Each layer''s activations are a weighted sum of the previous layer, passed through a squashing function.","Learning means finding the weights and biases that make the output layer match the right digit."]},{"id":"b04","type":"paragraph","text":"It pairs well with the [precision and recall](#/?item=precision-and-recall-without-the-confusion) article, which covers how to judge a model once it has been trained."}]}',
  NULL,
  NULL,
  NULL,
  'https://www.youtube.com/watch?v=aircAruvnKk',
  NULL
);

-- link: fermi-problems
INSERT OR IGNORE INTO items (id, slug, type, category_id, language, title, description, tags_json, links_json, added_at, updated_at, body_json, reading_minutes, file_url, page_count, video_url, url) VALUES (
  'itm_fermi_problems',
  'fermi-problems',
  'link',
  'cat_science',
  'en',
  'Fermi Problems',
  'Estimating seemingly impossible quantities, like the number of piano tuners in Chicago, with nothing but reasonable assumptions and orders of magnitude.',
  '["estimation","physics","problem solving","Enrico Fermi"]',
  '[]',
  '2026-10-21',
  '2026-10-21',
  '{"blocks":[{"id":"b01","type":"heading","level":2,"text":"The classic example"},{"id":"b02","type":"paragraph","text":"How many piano tuners work in Chicago? Nobody knows the answer offhand, but a chain of rough guesses gets surprisingly close:"},{"id":"b03","type":"list","ordered":true,"items":["About 3 million people live in Chicago, roughly 2 per household: **1.5 million households**.","Perhaps 1 household in 20 owns a piano: **about 75,000 pianos**.","Each piano is tuned about once a year: **75,000 tunings a year**.","A tuner can do about 4 a day, 250 days a year: **1,000 tunings per tuner**.","So Chicago needs roughly **75 piano tuners**."]},{"id":"b04","type":"paragraph","text":"Each guess may be off, but the errors tend to cancel out, and the answer is very likely in the right order of magnitude. That is the real lesson: an honest estimate beats no estimate."}]}',
  NULL,
  NULL,
  NULL,
  NULL,
  'https://en.wikipedia.org/wiki/Fermi_problem'
);

-- article: precision-and-recall-without-the-confusion
INSERT OR IGNORE INTO items (id, slug, type, category_id, language, title, description, tags_json, links_json, added_at, updated_at, body_json, reading_minutes, file_url, page_count, video_url, url) VALUES (
  'itm_precision_recall',
  'precision-and-recall-without-the-confusion',
  'article',
  'cat_science',
  'en',
  'Precision and Recall Without the Confusion',
  'Why accuracy misleads on imbalanced data, how precision, recall and F1 differ, and a worked spam-filter example.',
  '["machine learning","statistics","evaluation","metrics"]',
  '[{"label":"Precision and recall on Wikipedia","url":"https://en.wikipedia.org/wiki/Precision_and_recall"}]',
  '2026-10-14',
  '2026-10-14',
  '{"blocks":[{"id":"b01","type":"paragraph","text":"Accuracy is the first metric most people reach for, and it is often the wrong one. If 2% of transactions are fraudulent, a model that labels every transaction as legitimate is 98% accurate and *completely useless*. Precision and recall exist to describe what accuracy hides."},{"id":"b02","type":"heading","level":2,"text":"The confusion matrix"},{"id":"b03","type":"paragraph","text":"For a binary classifier, every prediction falls into one of four groups:"},{"id":"b04","type":"list","ordered":false,"items":["True positive (TP): predicted positive, actually positive.","False positive (FP): predicted positive, actually negative.","False negative (FN): predicted negative, actually positive.","True negative (TN): predicted negative, actually negative."]},{"id":"b05","type":"heading","level":2,"text":"Two different questions"},{"id":"b06","type":"paragraph","text":"**Precision** answers the question: when the model says positive, how often is it right? **Recall** answers a different one: of all the real positives, how many did the model find? The **F1 score** combines both as their harmonic mean."},{"id":"b07","type":"code","language":"text","text":"precision = TP / (TP + FP)\nrecall    = TP / (TP + FN)\nF1        = 2 × precision × recall / (precision + recall)"},{"id":"b08","type":"heading","level":2,"text":"A worked example"},{"id":"b09","type":"paragraph","text":"Imagine a spam filter tested on 100 emails, 20 of which are spam. The filter flags 25 emails, and 15 of those are genuinely spam."},{"id":"b10","type":"list","ordered":false,"items":["TP = 15: spam correctly flagged.","FP = 10: legitimate emails sent to the spam folder.","FN = 5: spam that reached the inbox.","TN = 70: legitimate emails correctly delivered."]},{"id":"b11","type":"paragraph","text":"Precision is 15 / 25 = 0.60 and recall is 15 / 20 = 0.75, so F1 is 2 × 0.60 × 0.75 / 1.35 ≈ 0.67. Accuracy is (15 + 70) / 100 = 0.85, which sounds respectable but says nothing about the ten real emails that disappeared into the spam folder."},{"id":"b11a","type":"details","summary":"Why a harmonic mean instead of a simple average?","blocks":[{"id":"b11b","type":"paragraph","text":"The harmonic mean is pulled towards the smaller of the two values. A model with precision 1.0 and recall 0.02 has an ordinary average of 0.51, which looks acceptable, but an F1 score of about 0.04, which correctly says that the model finds almost nothing."}]},{"id":"b12","type":"heading","level":2,"text":"Choosing what to optimise"},{"id":"b13","type":"paragraph","text":"Most classifiers output a score, and a threshold turns that score into a decision. Raising the threshold usually increases precision and lowers recall; lowering it does the opposite. The right balance depends on the cost of each kind of mistake."},{"id":"b14","type":"list","ordered":false,"items":["Medical screening favours recall: missing a case is worse than ordering an extra test.","Spam filtering favours precision: losing an important email is worse than seeing an occasional advert.","Search ranking often measures precision among the top few results, because people rarely scroll far."]},{"id":"b15","type":"quote","text":"Before choosing a metric, write down what a false positive costs and what a false negative costs. The metric usually chooses itself."}]}',
  3,
  NULL,
  NULL,
  NULL,
  NULL
);

-- article: what-goalkeeping-taught-me
INSERT OR IGNORE INTO items (id, slug, type, category_id, language, title, description, tags_json, links_json, added_at, updated_at, body_json, reading_minutes, file_url, page_count, video_url, url) VALUES (
  'itm_goalkeeping',
  'what-goalkeeping-taught-me',
  'article',
  'cat_personal',
  'ar',
  'ما علّمتني إياه حراسة المرمى',
  'في كرة القدم لا يتذكّر أحدٌ الحارس إلا عندما يخطئ. ملاحظات قصيرة عن الضغط والتركيز والمسؤولية.',
  '["football","goalkeeping","sport","focus","كرة القدم","حراسة المرمى","رياضة"]',
  '[]',
  '2026-10-09',
  '2026-10-09',
  '{"blocks":[{"id":"b01","type":"paragraph","text":"ألعب حارسًا للمرمى منذ سنوات. إنه المركز الذي لا يتذكّرك فيه أحد غالبًا إلا عندما يحدث خطأ، ومع ذلك أحبّه كثيرًا. تعلّمت منه أشياء أستعملها خارج الملعب أكثر مما توقّعت."},{"id":"b02","type":"heading","level":2,"text":"التركيز في اللحظات الهادئة"},{"id":"b03","type":"paragraph","text":"قد تمرّ عشرون دقيقة دون أن تلمس الكرة، ثم يأتي هجوم واحد يحسم كل شيء. الصعب ليس التصدّي نفسه، بل أن تبقى حاضرًا طوال الوقت الذي لا يحدث فيه شيء."},{"id":"b04","type":"heading","level":2,"text":"نسيان الخطأ بسرعة"},{"id":"b05","type":"paragraph","text":"إذا دخل هدف فلا وقت للحزن. الكرة التالية قد تصل بعد دقيقة، والحارس الذي يفكّر في الهدف السابق سيخسر الهدف التالي أيضًا. أحاول أن أتعامل مع الأخطاء في العمل بالطريقة نفسها: أفهم ما حدث، ثم أعود إلى اللعب."},{"id":"b06","type":"heading","level":2,"text":"التواصل مسؤولية"},{"id":"b07","type":"paragraph","text":"يرى الحارس الملعب كله، ولهذا عليه أن يتكلّم: أن ينبّه المدافعين وينظّم الصفوف قبل أن يقع الخطر. كثير من الأهداف تُمنع بكلمة في الوقت المناسب، لا بقفزة."},{"id":"b08","type":"quote","text":"أفضل تصدٍّ هو الذي لم تكن بحاجة إليه، لأنك نظّمت الدفاع قبله."}]}',
  1,
  NULL,
  NULL,
  NULL,
  NULL
);

-- article: how-git-stores-your-code
INSERT OR IGNORE INTO items (id, slug, type, category_id, language, title, description, tags_json, links_json, added_at, updated_at, body_json, reading_minutes, file_url, page_count, video_url, url) VALUES (
  'itm_git_internals',
  'how-git-stores-your-code',
  'article',
  'cat_other',
  'en',
  'How Git Stores Your Code',
  'Blobs, trees, commits and references: the small data model behind Git, and why it makes history easier to reason about.',
  '["Git","version control","programming"]',
  '[]',
  '2026-10-03',
  '2026-10-03',
  '{"blocks":[{"id":"b01","type":"paragraph","text":"Most people learn Git as a list of commands: add, commit, push, pull. That works until something goes wrong and the commands stop making sense. Underneath, Git is a small and elegant database, and once you see its shape, most of its behaviour becomes predictable."},{"id":"b02","type":"heading","level":2,"text":"Everything is an object"},{"id":"b03","type":"paragraph","text":"Git stores your project as objects inside the `.git/objects` directory. Each object is named by a hash of its contents, which is why Git is described as a **content-addressable store**. By default that hash is SHA-1; recent versions of Git can also create repositories that use SHA-256. There are four kinds of object."},{"id":"b04","type":"list","ordered":false,"items":["**Blob:** the contents of a single file. A blob has no name and no permissions, only bytes.","**Tree:** a directory listing that maps names and file modes to blobs and to other trees.","**Commit:** a pointer to one top-level tree, plus the author, the committer, a message, and the hashes of its parent commits.","**Annotated tag:** a named pointer to another object, usually a commit, with its own message and optional signature."]},{"id":"b05","type":"paragraph","text":"Because an object''s name is derived from its content, identical files anywhere in your history are stored once. Changing a single character produces a new blob with a new hash, which produces a new tree, which produces a new commit."},{"id":"b06","type":"heading","level":2,"text":"Looking inside a commit"},{"id":"b07","type":"paragraph","text":"You can inspect any object with `git cat-file`. Asking for the commit that HEAD points to prints something like this:"},{"id":"b08","type":"code","language":"shell","text":"$ git cat-file -p HEAD\ntree 9c1e4b7d2a6f0835e1c94b2d7a3f6e08c5b1d4a9\nparent 4f2a81e0c3d97b56a10e4f8c2b6d3a95e7f0c142\nauthor Mohamad Ibrahim <mohamad@example.com> 1761552000 +0100\ncommitter Mohamad Ibrahim <mohamad@example.com> 1761552000 +0100\n\nAdd reading time to article cards"},{"id":"b09","type":"paragraph","text":"Following the tree line with another cat-file call shows the directory listing for that snapshot, and following any blob shows the raw file. No diff is stored in this chain: every commit describes a *complete snapshot*, and Git computes diffs on demand by comparing trees."},{"id":"b10","type":"quote","text":"On disk, Git later packs objects together and compresses similar ones as deltas. That is a storage optimisation. The model you work with is always snapshots."},{"id":"b11","type":"heading","level":2,"text":"Branches are just names"},{"id":"b12","type":"paragraph","text":"A branch is a reference: a name stored under `.git/refs/heads` that contains the hash of one commit. Creating a branch writes that one small reference and copies none of your code. HEAD is usually a symbolic reference whose content is a line such as `ref: refs/heads/main`."},{"id":"b13","type":"paragraph","text":"When you commit, Git writes the new objects and moves the branch that HEAD points to forward to the new commit. A detached HEAD simply means HEAD contains a commit hash directly instead of the name of a branch."},{"id":"b14","type":"heading","level":2,"text":"Why this matters day to day"},{"id":"b15","type":"list","ordered":false,"items":["Commits are cheap, so commit small and often. Git only writes objects for content that changed.","Rewriting history with rebase or amend never edits a commit. It creates new commits and moves a branch to point at them.","Lost work is rarely lost. If a commit was ever made, `git reflog` will usually show its hash for weeks afterwards."]},{"id":"b16","type":"paragraph","text":"Git feels complicated because its interface grew over many years. Its data model did not. Blobs, trees, commits, and references are enough to explain almost every command you will ever run."},{"id":"b17","type":"details","summary":"Try it yourself in any repository","blocks":[{"id":"b17a","type":"paragraph","text":"Run these commands inside a Git repository to walk from a commit down to a single file:"},{"id":"b17b","type":"code","language":"shell","text":"git cat-file -t HEAD          # prints: commit\ngit cat-file -p HEAD^{tree}   # the top-level directory listing\ngit cat-file -p HEAD:README.md # the contents of one file (a blob)"},{"id":"b17c","type":"paragraph","text":"The chapter on [Git objects in Pro Git](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects) goes further and builds a commit by hand."}]}]}',
  3,
  NULL,
  NULL,
  NULL,
  NULL
);

-- youtube: steve-jobs-stanford-commencement
INSERT OR IGNORE INTO items (id, slug, type, category_id, language, title, description, tags_json, links_json, added_at, updated_at, body_json, reading_minutes, file_url, page_count, video_url, url) VALUES (
  'itm_jobs_commencement',
  'steve-jobs-stanford-commencement',
  'youtube',
  'cat_thoughts',
  'en',
  'Steve Jobs'' 2005 Stanford Commencement Address',
  'Three short stories about connecting the dots, love and loss, and death, from the speech Steve Jobs gave to Stanford graduates in 2005.',
  '["speech","career","life","Stanford","inspiration"]',
  '[{"label":"Full transcript (Stanford Report)","url":"https://news.stanford.edu/stories/2005/06/youve-got-find-love-jobs-says"}]',
  '2026-09-26',
  '2026-09-26',
  '{"blocks":[{"id":"b01","type":"heading","level":2,"text":"What stays with me"},{"id":"b02","type":"paragraph","text":"The first story is the one I return to most: you cannot connect the dots looking forward, only looking back. Studying several specialisations before choosing software engineering felt scattered at the time. In hindsight, each one added something."},{"id":"b03","type":"quote","text":"You can''t connect the dots looking forward; you can only connect them looking backwards."}]}',
  NULL,
  NULL,
  NULL,
  'https://youtu.be/UF8uR6Z6KLc',
  NULL
);

-- pdf: gradient-descent-lecture-notes
INSERT OR IGNORE INTO items (id, slug, type, category_id, language, title, description, tags_json, links_json, added_at, updated_at, body_json, reading_minutes, file_url, page_count, video_url, url) VALUES (
  'itm_gradient_descent',
  'gradient-descent-lecture-notes',
  'pdf',
  'cat_science',
  'en',
  'Gradient Descent: Lecture Notes',
  'The update rule, a fully worked one-dimensional example, choosing a learning rate, mini-batches, and momentum.',
  '["optimisation","machine learning","mathematics","SGD"]',
  '[]',
  '2026-09-21',
  '2026-09-21',
  NULL,
  NULL,
  'documents/gradient-descent-lecture-notes.pdf',
  2,
  NULL,
  NULL
);

-- link: astronomy-picture-of-the-day
INSERT OR IGNORE INTO items (id, slug, type, category_id, language, title, description, tags_json, links_json, added_at, updated_at, body_json, reading_minutes, file_url, page_count, video_url, url) VALUES (
  'itm_apod',
  'astronomy-picture-of-the-day',
  'link',
  'cat_interesting_finds',
  'en',
  'Astronomy Picture of the Day',
  'Every day since 1995, NASA has published one image of the universe with a short explanation written by a professional astronomer.',
  '["space","astronomy","NASA","photography"]',
  '[]',
  '2026-09-15',
  '2026-09-15',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  'https://apod.nasa.gov/apod/'
);

-- article: designing-interfaces-that-feel-calm
INSERT OR IGNORE INTO items (id, slug, type, category_id, language, title, description, tags_json, links_json, added_at, updated_at, body_json, reading_minutes, file_url, page_count, video_url, url) VALUES (
  'itm_calm_interfaces',
  'designing-interfaces-that-feel-calm',
  'article',
  'cat_thoughts',
  'en',
  'Designing Interfaces That Feel Calm',
  'Four habits that make software feel calm: showing less at once, making state obvious, preferring stillness, and staying predictable.',
  '["design","UX","software","accessibility"]',
  '[]',
  '2026-09-12',
  '2026-09-12',
  '{"blocks":[{"id":"b01","type":"paragraph","text":"Some software leaves you feeling capable. Other software leaves you slightly anxious even when it works. The difference is rarely a single feature; it is the accumulation of small decisions about what to show, when to show it, and how loudly."},{"id":"b02","type":"heading","level":2,"text":"Show less at once"},{"id":"b03","type":"paragraph","text":"Every visible element competes for attention. A calm interface shows what the current task needs and keeps the rest one step away. *Progressive disclosure*, revealing advanced options only when someone asks for them, keeps the first impression simple without taking power away from experienced users."},{"id":"b04","type":"heading","level":2,"text":"Make state obvious"},{"id":"b05","type":"paragraph","text":"Anxiety often comes from uncertainty. Did my change save? Is it still loading? What happens if I press this? Clear labels, visible confirmation after an action, and honest loading and empty states answer those questions before anyone has to ask them."},{"id":"b06","type":"heading","level":2,"text":"Prefer stillness"},{"id":"b07","type":"paragraph","text":"Motion is powerful because the eye cannot ignore it, which is exactly why too much of it is tiring. Reserve movement for moments that genuinely need attention, and respect the operating system''s reduced motion setting for people who are sensitive to it."},{"id":"b08","type":"heading","level":2,"text":"Be predictable"},{"id":"b09","type":"list","ordered":false,"items":["The same action should look the same everywhere in the product.","Buttons should say what they do: **Save changes** is clearer than **OK**.","Destructive actions deserve a pause and a clear way back."]},{"id":"b10","type":"quote","text":"Calm design is not the same as minimal design. It is design in which nothing surprises the person using it."},{"id":"b11","type":"paragraph","text":"A useful test is to watch someone use your product without explaining anything. Every moment of hesitation marks a place where the interface could have been quieter or clearer."}]}',
  2,
  NULL,
  NULL,
  NULL,
  NULL
);

-- youtube: the-egg-a-short-story
INSERT OR IGNORE INTO items (id, slug, type, category_id, language, title, description, tags_json, links_json, added_at, updated_at, body_json, reading_minutes, file_url, page_count, video_url, url) VALUES (
  'itm_the_egg',
  'the-egg-a-short-story',
  'youtube',
  'cat_interesting_finds',
  'en',
  'The Egg: A Short Story',
  'Kurzgesagt''s animated adaptation of Andy Weir''s short story about life, death, and what it might mean to be everyone.',
  '["animation","philosophy","Kurzgesagt","Andy Weir","story"]',
  '[]',
  '2026-09-02',
  '2026-09-02',
  NULL,
  NULL,
  NULL,
  NULL,
  'https://www.youtube.com/watch?v=h6fcK_fRYaI',
  NULL
);

-- pdf: writing-technical-specifications
INSERT OR IGNORE INTO items (id, slug, type, category_id, language, title, description, tags_json, links_json, added_at, updated_at, body_json, reading_minutes, file_url, page_count, video_url, url) VALUES (
  'itm_tech_specs',
  'writing-technical-specifications',
  'pdf',
  'cat_other',
  'en',
  'Writing Technical Specifications That Get Read',
  'A practical structure for design documents: problem, goals and non-goals, design, alternatives, risks, and rollout.',
  '["writing","documentation","teamwork"]',
  '[]',
  '2026-08-29',
  '2026-08-29',
  NULL,
  NULL,
  'documents/writing-technical-specifications.pdf',
  2,
  NULL,
  NULL
);

-- article: fitts-law-in-everyday-interfaces
INSERT OR IGNORE INTO items (id, slug, type, category_id, language, title, description, tags_json, links_json, added_at, updated_at, body_json, reading_minutes, file_url, page_count, video_url, url) VALUES (
  'itm_fitts_law',
  'fitts-law-in-everyday-interfaces',
  'article',
  'cat_science',
  'en',
  'Fitts''s Law in Everyday Interfaces',
  'The seventy-year-old formula from psychology that explains why big, nearby buttons feel effortless, with a quick worked example.',
  '["psychology","HCI","design","pointing"]',
  '[{"label":"Fitts''s law on Wikipedia","url":"https://en.wikipedia.org/wiki/Fitts%27s_law"}]',
  '2026-08-16',
  '2026-08-16',
  '{"blocks":[{"id":"b01","type":"paragraph","text":"In 1954 the psychologist Paul Fitts showed that the time needed to point at a target depends on two things: how far away it is and how big it is. More than seventy years later, the same relationship explains why some buttons feel effortless and others feel fiddly."},{"id":"b02","type":"heading","level":2,"text":"The formula"},{"id":"b03","type":"paragraph","text":"The version most often used in human-computer interaction is the Shannon formulation, popularised by Scott MacKenzie:"},{"id":"b04","type":"code","language":"text","text":"MT = a + b × log2(D / W + 1)"},{"id":"b05","type":"paragraph","text":"MT is the movement time, D is the distance to the centre of the target, W is the width of the target along the direction of movement, and a and b are constants measured for a particular device and user. The logarithmic term is called the **index of difficulty** and is measured in bits."},{"id":"b06","type":"heading","level":2,"text":"A quick example"},{"id":"b07","type":"paragraph","text":"Moving 400 pixels to a button 20 pixels wide gives an index of difficulty of log2(400 / 20 + 1) = log2(21) ≈ 4.39 bits. Widening the button to 80 pixels reduces it to log2(6) ≈ 2.58 bits. The constants decide how many milliseconds that saves, but the direction never changes: the wider target is easier to hit."},{"id":"b08","type":"heading","level":2,"text":"What it means in practice"},{"id":"b09","type":"list","ordered":false,"items":["Bigger targets are faster to hit, which matters most on touch screens.","Closer targets are faster to reach, so place related actions near where attention already is.","Screen edges behave like infinitely deep targets for a mouse, because the pointer stops at the edge. That is why menus along the very top of the screen are quick to reach.","Tightly packed small targets increase errors, not just time."]},{"id":"b10","type":"paragraph","text":"Fitts''s law does not cover everything. It describes pointing, not reading, deciding, or remembering. But whenever an interface asks someone to move a pointer or a finger to a target, it is a reliable guide."}]}',
  2,
  NULL,
  NULL,
  NULL,
  NULL
);
