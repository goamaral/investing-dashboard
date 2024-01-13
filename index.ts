import puppeteer, { Browser, Page, TimeoutError } from 'puppeteer'
import { DateTime } from 'luxon'
import fs from 'node:fs'

function getFloat(text: string, ticker?: string): number {
	if (text === '') throw new Error(`empty ${ticker}`)
	const value = parseFloat(text)
	if (isNaN(value)) throw new Error(`not a number ${text}`)
	return value
}

function xpathSelector(p: string): string {
	return `::-p-xpath(${p})`
}

async function getElTextFromXpath(page: Page, xpath: string): Promise<string> {
	const elHandle = await page.waitForSelector(xpathSelector(xpath))
	if (elHandle === null) throw new Error('not found')
	const text = await page.evaluate(el => el.textContent, elHandle)
	await elHandle.dispose()
	return text === null ? '' : text
}

interface YahooFinanceData {
	price: number
	earningsDate: string
	dividendAndYield: string
	exDividendDate: string
	prediction: number
	weekGrowthPercentage: number
}

async function getYahooFinanceData(
	browser: Browser,
	ticker: string,
): Promise<YahooFinanceData> {
	ticker = ticker == 'BRK.B' ? ticker.replaceAll('.', '-') : ticker
	const page = await browser.newPage()
	await page.setJavaScriptEnabled(false)
	await page.goto(`https://finance.yahoo.com/quote/${ticker}`)

	if (page.url().includes('https://consent.yahoo.com/v2/collectConsent')) {
		const acceptTermsEl = await page.waitForSelector(
			'#consent-page > div > div > div > form > div.wizard-body > div.actions.couple > button.btn.secondary.accept-all',
		)
		if (acceptTermsEl === null) throw new Error('acceptTerms not found')
		await acceptTermsEl.click()
		await acceptTermsEl.dispose()
	}

	const priceText = await getElTextFromXpath(
		page,
		'//*[@id="quote-header-info"]/div[3]/div[1]/div[1]/fin-streamer[1]',
	)
	const price = getFloat(priceText.replaceAll(',', ''), ticker)

	const earningsDate = await getElTextFromXpath(
		page,
		'//*[@id="quote-summary"]/div[2]/table/tbody/tr[5]/td[2]',
	)
	const dividendAndYield = await getElTextFromXpath(
		page,
		'//*[@id="quote-summary"]/div[2]/table/tbody/tr[6]/td[2]',
	)
	const exDividendDate = await getElTextFromXpath(
		page,
		'//*[@id="quote-summary"]/div[2]/table/tbody/tr[7]/td[2]',
	)
	const predictionText = await getElTextFromXpath(
		page,
		'//*[@id="quote-summary"]/div[2]/table/tbody/tr[8]/td[2]',
	)
	const prediction = getFloat(predictionText, ticker)

	await page.goto(`https://finance.yahoo.com/quote/${ticker}/history`)
	const lastTenDaysHistory = await page.evaluate(() => {
		const rows = Array.from(document.querySelectorAll('#Col1-1-HistoricalDataTable-Proxy > section > div.Pb\\(10px\\).Ovx\\(a\\).W\\(100\\%\\) > table > tbody tr:nth-child(-n+10)'))
		return rows.map(row => Array.from(row.querySelectorAll('td')).map(td => td.innerText))
	})
	const monday = DateTime.local().set({ weekday: 1 }).startOf('day')//.minus({ week: 1 })
	const weekHistory = lastTenDaysHistory.filter(e => DateTime.fromFormat(e[0], 'LLL dd, yyyy') >= monday)
	const weekOpen = getFloat(weekHistory[weekHistory.length - 1][2].replaceAll(',', ''), ticker)
	const weekClose = getFloat(weekHistory[0][1].replaceAll(',', ''), ticker)
	const weekGrowthPercentage = ((weekClose - weekOpen) / weekOpen) * 100

	await page.close()

	return {
		price,
		earningsDate,
		dividendAndYield,
		exDividendDate,
		prediction,
		weekGrowthPercentage,
	}
}

async function getGurufocusPrediction(
	browser: Browser,
	ticker: string,
): Promise<number> {
	const page = await browser.newPage()
	await page.setJavaScriptEnabled(false)
	await page.goto(`https://www.gurufocus.com/stock/${ticker}/summary`)

	let predictionText = '00'
	try {
		predictionText = await getElTextFromXpath(
			page,
			'//*[@id="components-root"]/div[1]/div[4]/div[2]/div[2]/div[1]/div[1]/h2/a/span',
		)
	} catch (err) {
		if (err instanceof TimeoutError) {
			console.error(`Alphaspread prediction for ${ticker} timedout`)
		} else {
			throw err
		}
	}

	await page.close()
	return getFloat(predictionText.substring(1))
}

async function getZacksPrediction(browser: Browser, ticker: string): Promise<number> {
	const page = await browser.newPage()
	await page.setJavaScriptEnabled(false)
	await page.goto(
		`https://www.zacks.com/stock/research/${ticker}/price-target-stock-forecast`,
	)

	const predictionText = await getElTextFromXpath(
		page,
		'//*[@id="right_content"]/section[2]/div/table/tbody/tr/th/text()'
	)
	await page.close()
	return getFloat(predictionText.substring(1).replaceAll(',', ''))
}

async function getAlphaspreadPrediction(
	browser: Browser,
	ticker: string,
): Promise<number> {
	const page = await browser.newPage()
	await page.setJavaScriptEnabled(false)
	await page.goto(
		`https://www.alphaspread.com/security/nasdaq/${ticker}/analyst-estimates`,
	)

	let predictionText = '0'
	try {
		predictionText = await getElTextFromXpath(
			page,
			'//*[@id="main"]/div[3]/div[1]/div/div[1]/div/div[4]/div/div[2]/a/div/div/div[2]',
		)
	} catch (err) {
		if (err instanceof TimeoutError) {
			console.error(`Alphaspread prediction for ${ticker} timedout`)
		} else {
			throw err
		}
	}

	await page.close()
	return getFloat(predictionText.replaceAll(' ', ''))
}

interface Summary {
	yahooFinance: YahooFinanceData
	predictions: {
		zacks: number
		alphaspread: number
		yahoo: number
	}
}

async function getSummary(browser: Browser, ticker: string): Promise<Summary> {
	const [yahooFinance, zacks, alphaspread] = await Promise.all([
		getYahooFinanceData(browser, ticker),
		getZacksPrediction(browser, ticker),
		getAlphaspreadPrediction(browser, ticker),
	])
	return {
		yahooFinance,
		predictions: { zacks, alphaspread, yahoo: yahooFinance.prediction },
	}
}

async function getSummaries(tickers: string[]): Promise<{ [key: string]: Summary }> {
	const browser = await puppeteer.launch({ headless: false })

	const summaries = await Promise.all(tickers.map(ticker => getSummary(browser, ticker)))

	await browser.close()

	return Object.fromEntries(summaries.map((s, i) => [tickers[i], s]))
}

function growthPercentage(price: number, prediction: number) {
	return ((prediction / price) - 1) * 100
}

async function sleep(seconds: number) {
	return new Promise(resolve => setTimeout(resolve, seconds * 1000))
}

async function processCategory(fd: number, category: string, tickers: string[]) {
	console.log(`Processing ${category}`)
	const summaries = await getSummaries(tickers)

	fs.writeSync(fd, `${category}\n`)

	for (const ticker in summaries) {
		const summary = summaries[ticker]
		const price = summary.yahooFinance.price
		const zacksPercentage = growthPercentage(price, summary.predictions.zacks)
		const alphaspreadPercentage = growthPercentage(price, summary.predictions.alphaspread)
		const yahooPercentage = growthPercentage(price, summary.predictions.alphaspread)

		const line = [
			ticker,
			price,
			`${summary.predictions.zacks} (${Math.floor(zacksPercentage)}%)`,
			`${summary.predictions.alphaspread} (${Math.floor(alphaspreadPercentage)}%)`,
			`${summary.predictions.yahoo} (${Math.floor(yahooPercentage)}%)`,
			Math.floor((zacksPercentage + alphaspreadPercentage + yahooPercentage) / 3),
			`${summary.yahooFinance.weekGrowthPercentage.toFixed(2)}%`,
		].join('\t')

		fs.writeSync(fd, `${line}\n`)
	}

	fs.writeSync(fd, '\n')
}

if (require.main === module) {
	const fd = fs.openSync('output.sheets', 'w')
	processCategory(fd, 'Safe', ['PG', 'JPM', 'TXN', 'AVGO', 'MCD', 'KO', 'PEP'])
		.then(() => sleep(20))
		.then(() => processCategory(fd, 'Safe No Dividends', ['AAPL', 'MSFT', 'ORCL', 'SONY', 'BRK.B', 'GOOG']))
		.then(() => sleep(20))
		.then(() => processCategory(fd, 'REIT', ['SBRA', 'OHI']))
		.then(() => sleep(20))
		.then(() => processCategory(fd, 'Watchlist', ['CSCO', 'JNJ', 'HPQ', 'SHOP', 'NET', 'MDB', 'QCOM', 'V', 'SNOW']))
		.then(() => fs.closeSync(fd))
}