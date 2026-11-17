"""Seed prompts for the TenAI intent gate: code_task / code_question / out_of_scope.

Templates over real OpenWallet components so the gate learns "this is about our codebase", plus a wide spread of
everyday requests people try on a chat box. Deterministic (seeded) so retraining is reproducible.
"""
import itertools
import random

COMPONENTS = [
    "HBLProcessor", "UBL FundTransfer request", "CityBankSoapBuilder", "the beneficiary missing details API",
    "BeneficiaryServiceImpl", "the Send Again list", "TransactionServiceImpl", "the status inquiry scheduler",
    "the HBL bank code sync", "ProviderBankCoverage", "the incentive engine campaign ledger", "the Admin Console user management page",
    "the merchant portal payout table", "the developer portal navbar", "RegionService in the developer portal",
    "the OTP login flow", "the Kafka notification listener", "the Liquibase changelog", "the JWT filter",
    "the RBAC permission checker", "the treasury beneficiary validator", "the refund maker-checker API", "the QR payment handler",
    "the user segmentation rules", "the TerraPay processor", "the IME SOAP builder", "the YesBank RTPS strategy",
    "the HomePay validator", "the HNB transaction builder", "the wallet balance endpoint", "the settlement poller",
    "the Angular sidebar component", "the beneficiary form config", "the exchange rate service", "the audit trail service",
]
FILES = ["HBLProcessor.java", "UBLProcessor.java", "BeneficiaryController.java", "region.service.ts", "navbar.component.html",
         "SchedulerService.java", "application.yml", "BankCodeSyncServiceImpl.java", "styles.scss", "TransactionInfo.java",
         "build.gradle", "user-management.component.ts", "pom.xml", "CityBankSoapBuilderDobTest.java"]

TASK_TEMPLATES = [
    "add {thing} to {c}", "fix the bug in {c} where {bug}", "refactor {c} to {refactor}", "write unit tests for {c}",
    "update {f} so that {change}", "rename {old} to {new} in {c}", "remove the unused code in {f}", "make {c} {behaviour}",
    "implement {thing} in {c}", "add validation for {field} in {c}", "change the {field} format in {c} to {fmt}",
    "handle the null {field} case in {c}", "add logging around {c} without logging secrets", "create a new endpoint in {c} that {does}",
    "migrate {c} to use {lib}", "bump the version of {lib} in {f}", "add a column {field} with a liquibase changeset",
    "the build is failing in {f}, fix it", "port the change in {c} to the UAE repo", "add a feature flag for {thing} in {c}",
    "write a SQL migration file that adds an index on {field}", "make the {ui} in {c} responsive", "add a loading spinner to the {ui}",
    "fix the NullPointerException in {f}", "add retry with backoff to {c}", "cover {c} with an integration test",
    "can you {verb} {c} so {change}", "please {verb} {f} to {change}", "{verb} {c}: {change}",
    "write a test that covers {case}", "write a {kind} for {c}", "split the {field} into {parts}", "map {field} to {field2} in {c}",
    "{who} wants {field} in {c}, add it", "send {field} in the {c} request", "drop the {field} column from the {ui}",
    "{c} should {behaviour}, implement that", "return {field} in the response of {c}", "default {field} to {fmt} when it is blank",
]
QUESTION_TEMPLATES = [
    "how does {c} work", "where is {field} set in {c}", "why does {c} {symptom}", "explain {c}", "what calls {c}",
    "which class builds {thing}", "walk me through {c}", "what does {f} do", "where do we read {field}", "find where {c} handles {thing}",
    "does {c} support {thing}?", "what happens in {c} when {bug}", "is there a test for {c}?", "summarize the changes in {f}",
    "how is {field} mapped from the beneficiary to {c}", "trace a transaction through {c}", "which repo has {c}",
    "what is the difference between {c} and {c2}", "list the endpoints in {f}", "who calls {f} and when",
    # history: who changed what (answered from git log/show)
    "what changes were made by {who} in {c}", "what did {who} change in {c} {when}", "who changed {f} last",
    "show me the latest {git}", "show the last {n} commits on {c}", "list the recent {git}", "any new {git} {when}?",
    "what are the latest {git} on env/dev", "give me the {git} from {when}", "what did {who} push {when}", "what was merged {when}",
    "which MR added {thing} to {c}", "when was {field} added to {c}", "who wrote {c}", "what changed in {c} {when}",
    "list {who}'s commits {when}", "summarize {who}'s last merge request", "what went into env/dev {when}",
    "is {c} encrypted?", "is {field} validated in {c}?", "which table stores {field}?", "do we log {field} anywhere?",
    "why is {field} null for {country} beneficiaries?", "what does the {code} response code mean in {c}",
]
THINGS = ["a regex check", "pagination", "a missingDetails flag", "date of birth validation", "an audit log entry", "a cache",
          "a timeout", "a dark mode toggle", "an IBAN check", "a retry", "rate limiting", "a new response field", "sorting"]
BUGS = ["the DOB is sent as yyyy-MM-dd", "the bank code is numeric", "the list is empty", "the token expires early",
        "the account title does not match", "the status stays pending", "the amount has too many decimals"]
REFACTORS = ["use a builder", "remove duplication", "split the method", "use constructor injection", "return Optional"]
CHANGES = ["it validates the account number", "it sends the ISO-3 country", "it stops on a 9043", "it uses the new DTO",
           "it masks the email in logs", "it reads the code from provider_bank_coverage", "it shows a pill for coming soon"]
FIELDS = ["remitter_dob", "beneficiaryId", "accountNo", "udf11", "last_region", "gender", "occupationId", "status", "bankType", "email",
          "remitter name", "first name", "last name", "account title", "IBAN", "mobile number", "purpose code", "response code"]
FMTS = ["dd/MM/yyyy", "ISO-8601", "two decimals", "uppercase"]
LIBS = ["Java 21 records", "the new HttpClient", "RxJS 7", "Angular signals", "Spring Boot 3.4"]
UIS = ["table", "modal", "form", "sidebar", "header", "dropdown"]
VERBS = ["fix", "update", "change", "refactor", "improve", "clean up"]
BEHAVIOURS = ["idempotent", "thread safe", "fail fast on bad input", "return 404 for missing beneficiaries"]
DOES = ["returns the missing fields", "lists bank codes", "exports the ledger", "re-validates the account"]
CASES = ["the 9048 mismatch case", "a blank account title", "the numeric bank code path", "an expired OTP", "a duplicate beneficiary",
         "the timeout retry", "the {field} being null"]
KINDS = ["unit test", "migration", "mapper", "DTO", "validator", "scheduler", "controller test", "helper"]
PARTS = ["first and last name", "two fields", "code and description", "date and time"]
WHO = ["Jordan", "Alex", "QA", "the product team", "ops", "Chandni", "alex", "chandni", "Casey", "Riley", "gajendra", "me", "Sagar"]
GIT = ["commits", "merges", "merge requests", "MRs", "changes on env/dev", "merged branches", "commits by the team"]
WHEN = ["yesterday", "today", "last week", "this week", "in the last 3 days", "since monday", "this sprint", "recently"]
COUNTRIES = ["PK", "BD", "IN", "NP", "LK", "PH"]
CODES = ["9043", "9048", "00", "02", "210", "N"]
SYMPTOMS = ["return 403", "time out", "send the wrong bank id", "skip the title check", "log the password"]

OUT_OF_SCOPE = [
    "tell me a joke", "write a poem about the monsoon", "what is the weather in dubai", "who won the cricket match yesterday",
    "translate good morning to arabic", "what is 17 times 23", "recommend a good movie", "how do I make biryani",
    "write a birthday message for my friend", "what is the capital of australia", "summarize today's news",
    "plan a weekend trip to oman", "how do I lose weight", "give me a motivational quote", "what's the bitcoin price",
    "write an email to HR asking for leave", "draft a linkedin post about my promotion", "how do I fix my home wifi",
    "my laptop is slow, what should I do", "explain quantum physics simply", "who is the CEO of google",
    "write a cover letter for a marketing job", "what should I gift my wife", "tell me about the history of rome",
    "play a game with me", "what is the meaning of life", "help me with my kid's maths homework", "write a rap song",
    "what time is it in london", "is it a good time to buy gold", "create a diet plan", "how many calories in a mango",
    "who are you", "how are you today", "let's chat", "what can you do besides code", "write a story about dragons",
    "convert 100 usd to aed", "book a meeting with alex tomorrow", "send a message to jordan on teams",
    "what is my salary", "how many leaves do I have left", "explain the rules of football", "best phones under 1000 aed",
    "write a speech for a wedding", "summarise this article about elections", "teach me spanish", "solve this sudoku",
    "what's trending on twitter", "how to invest in mutual funds", "describe the taj mahal", "suggest a name for my cat",
    "write marketing copy for a new perfume", "how to apply for a uae visa", "what are the symptoms of flu",
    # question shapes code prompts also use (which/where/is/why/how does), so the gate learns topic, not syntax
    "which hospital is open on friday", "which car should I buy", "which gym is near marina", "which phone has the best camera",
    "where can I buy cheap flights", "where should I eat tonight", "where is the nearest metro station",
    "is it going to rain tomorrow", "is coffee bad for health", "is dubai mall open late", "why is the sky blue",
    "why do cats purr", "how does a car engine work", "how does the stock market work", "what does inflation mean",
    "explain the offside rule", "walk me through making pasta", "who calls the shots in a startup", "list the best beaches in goa",
    "what happens when you skip breakfast", "find me a good barber", "does this shirt suit me", "trace my lost parcel",
    "what did you eat today", "what did you do yesterday", "what did my manager say in the meeting", "who won the match last week",
    "what happened in the news this week", "what did elon musk post recently", "show me the latest movies", "list the latest iphones",
    "what changed in the uae visa rules", "who changed the office wifi password", "what did the government announce yesterday",
    "fix my resume", "add some jokes to my speech", "update my linkedin headline", "rename my wifi network", "make my essay longer",
]
OOS_PREFIX = ["", "hey, ", "please ", "can you ", "quick one: ", "bro ", "hi tenai, "]


def generate(seed: int = 7, per_class: int = 420):
    rnd = random.Random(seed)

    def fill(t: str) -> str:
        c, c2 = rnd.sample(COMPONENTS, 2)
        old, new = rnd.sample(FIELDS, 2)
        return t.format(c=c, c2=c2, f=rnd.choice(FILES), thing=rnd.choice(THINGS), bug=rnd.choice(BUGS), refactor=rnd.choice(REFACTORS),
                        change=rnd.choice(CHANGES), field=rnd.choice(FIELDS), fmt=rnd.choice(FMTS), lib=rnd.choice(LIBS), ui=rnd.choice(UIS),
                        verb=rnd.choice(VERBS), old=old, new=new, behaviour=rnd.choice(BEHAVIOURS), does=rnd.choice(DOES),
                        symptom=rnd.choice(SYMPTOMS), case=rnd.choice(CASES).replace("{field}", old), parts=rnd.choice(PARTS),
                        field2=new, who=rnd.choice(WHO), country=rnd.choice(COUNTRIES), code=rnd.choice(CODES), kind=rnd.choice(KINDS), when=rnd.choice(WHEN), git=rnd.choice(GIT), n=rnd.choice([3, 5, 10, 20]))

    tasks = {fill(rnd.choice(TASK_TEMPLATES)) for _ in range(per_class * 3)}
    questions = {fill(rnd.choice(QUESTION_TEMPLATES)) for _ in range(per_class * 3)}
    oos = {p + q for p, q in itertools.product(OOS_PREFIX, OUT_OF_SCOPE)}
    # sample, not sorted()[:n]: an alphabetical cut silently drops whole templates starting late in the alphabet
    data = ([(t, "code_task") for t in rnd.sample(sorted(tasks), min(per_class, len(tasks)))]
            + [(q, "code_question") for q in rnd.sample(sorted(questions), min(per_class, len(questions)))]
            + [(o, "out_of_scope") for o in sorted(oos)])
    rnd.shuffle(data)
    return data


# Hand-written, never generated from the templates above: the gate must generalise to these.
HELDOUT = [
    ("Jordan wants remitter DOB back in the HBL request, add it", "code_task"),
    ("the HBL title fetch should also compare the name, implement that", "code_task"),
    ("fix the CityBank remitter_dob format to dd/MM/yyyy", "code_task"),
    ("add a scheduler that syncs bank codes every day", "code_task"),
    ("make the coming soon label a pill in the sidebar", "code_task"),
    ("write a test that covers the 9048 mismatch case", "code_task"),
    ("send the ISO-3 country code in RemitterAddress2", "code_task"),
    ("split the remitter name: first word first name, rest last name", "code_task"),
    ("remove the environment dropdown from the developer portal", "code_task"),
    ("add the X-Region header to the http interceptor behind a flag", "code_task"),
    ("where does UBL resolve the numeric bank code?", "code_question"),
    ("why is the beneficiary list returning missingDetails true for PK?", "code_question"),
    ("how is the send again list built?", "code_question"),
    ("which service owns the provider_bank_coverage table?", "code_question"),
    ("what does applyProviderBankCode do", "code_question"),
    ("explain the RBAC redis permission check", "code_question"),
    ("is the new beneficiary API encrypted?", "code_question"),
    ("how does the spine detect collisions", "code_question"),
    ("what changes were made by alex in last beneficiary", "code_question"),
    ("who touched the UBL processor recently?", "code_question"),
    ("what did casey merge into the rbac module", "code_question"),
    ("can you write me a haiku about payments", "out_of_scope"),
    ("what's the score in the india match", "out_of_scope"),
    ("draft a leave application for friday", "out_of_scope"),
    ("which restaurant is good near business bay", "out_of_scope"),
    ("what is love", "out_of_scope"),
    ("help me write a resignation letter", "out_of_scope"),
    ("how much is an iphone 17 in dubai", "out_of_scope"),
    ("tell me something funny", "out_of_scope"),
    ("good morning!", "out_of_scope"),
    ("what's the dirham to rupee rate today", "out_of_scope"),
]


# A second hand-written set, never used for tuning seeds (the blind check from the first deploy).
BLIND = [
    ("add an index on beneficiary user_id", "code_task"), ("the UBL validation fails with code 03, handle it", "code_task"),
    ("make the payout export include the provider reference", "code_task"), ("why does the shield login redirect twice", "code_question"),
    ("where do we decrypt the request body", "code_question"), ("rename getBankList to listBanks", "code_task"),
    ("what's in the HomePay status mapper", "code_question"), ("bump angular to 19 in the merchant portal", "code_task"),
    ("delete the dead feature flag code in the incentive module", "code_task"), ("how do campaigns reserve budget", "code_question"),
    ("can you explain kafka consumer groups in our notification service", "code_question"), ("add a null check before getAccountTitle", "code_task"),
    ("write a limerick", "out_of_scope"), ("what should I cook for dinner", "out_of_scope"), ("who will win the elections", "out_of_scope"),
    ("give me 5 startup ideas", "out_of_scope"), ("is bitcoin going up", "out_of_scope"), ("translate this to hindi: thank you", "out_of_scope"),
    ("how do I renew my emirates id", "out_of_scope"), ("recommend a book on stoicism", "out_of_scope"), ("what's 2+2", "out_of_scope"),
    ("hello", "out_of_scope"),
]

# The fixed exam every model version is judged on. Never trained on.
GOLDEN = HELDOUT + BLIND
