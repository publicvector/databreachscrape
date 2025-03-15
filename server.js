// server.js - A simple Express.js server to handle data scraping
const express = require('express');
const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for your Squarespace domain
app.use(cors());

// Cache the results for 1 hour
let cachedData = null;
let lastFetchTime = null;
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour in milliseconds

app.get('/api/breach-data', async (req, res) => {
  try {
    // Check if we have cached data that's still valid
    const now = Date.now();
    if (cachedData && lastFetchTime && (now - lastFetchTime < CACHE_DURATION)) {
      console.log('Returning cached data');
      return res.json(cachedData);
    }
    
    // Initialize result object
    const result = {
      meta: {
        timestamp: new Date().toISOString(),
        status: {
          hhs: false,
          maine: false,
          texas: false
        }
      },
      data: {
        hhs: [],
        maine: [],
        texas: []
      }
    };
    
    // Get HHS data
    try {
      console.log('Fetching HHS data...');
      const hhsData = await getHHSData();
      result.data.hhs = hhsData;
      result.meta.status.hhs = true;
      console.log(`Retrieved ${hhsData.length} HHS records`);
    } catch (error) {
      console.error('Error getting HHS data:', error);
    }
    
    // Launch browser for scraping
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    // Get Maine data
    try {
      console.log('Fetching Maine data...');
      const maineData = await getMaineData(browser);
      result.data.maine = maineData;
      result.meta.status.maine = true;
      console.log(`Retrieved ${maineData.length} Maine records`);
    } catch (error) {
      console.error('Error getting Maine data:', error);
    }
    
    // Get Texas data
    try {
      console.log('Fetching Texas data...');
      const texasData = await getTexasData(browser);
      result.data.texas = texasData;
      result.meta.status.texas = true;
      console.log(`Retrieved ${texasData.length} Texas records`);
    } catch (error) {
      console.error('Error getting Texas data:', error);
    }
    
    // Close browser
    await browser.close();
    
    // Update cache
    cachedData = result;
    lastFetchTime = now;
    
    res.json(result);
  } catch (error) {
    console.error('Error handling request:', error);
    res.status(500).json({ error: error.message });
  }
});

// Function to get HHS data
async function getHHSData() {
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    };
    
    const response = await axios.get('https://ocrportal.hhs.gov/ocr/breach/breach_report.jsf', { 
      headers,
      timeout: 30000
    });
    
    const $ = cheerio.load(response.data);
    const tableData = [];
    const table = $('table.ui-datatable-data');
    
    table.find('tr').each((rowIndex, row) => {
      if (rowIndex > 0) { // Skip header row
        const rowData = {};
        $(row).find('td').each((colIndex, col) => {
          const headerText = $(table).find('th').eq(colIndex).text().trim();
          rowData[headerText] = $(col).text().trim();
        });
        tableData.push(rowData);
      }
    });
    
    return tableData;
  } catch (error) {
    console.error('Error in getHHSData:', error);
    throw error;
  }
}

// Function to get Maine data (limited to 10 records for demo)
async function getMaineData(browser) {
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    
    await page.goto('https://www.maine.gov/agviewer/content/ag/985235c7-cb95-4be2-8792-a1252b4f8318/list.html', {
      waitUntil: 'networkidle2'
    });
    
    const urls = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links
        .filter(link => link.href && link.href.length > 100)
        .map(link => link.href)
        .slice(0, 10); // Limit to 10 for demonstration
    });
    
    const breachReports = [];
    
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      
      try {
        await page.goto(url, { waitUntil: 'networkidle2' });
        
        const reportData = await page.evaluate((url) => {
          const contentElement = document.querySelector('#content');
          if (!contentElement) return null;
          
          const lines = contentElement.innerText.split('\n');
          const dataObject = { URL: url };
          
          lines.forEach(line => {
            if (line.includes(': ')) {
              const [key, value] = line.split(': ', 2);
              dataObject[key] = value;
            }
          });
          
          return dataObject;
        }, url);
        
        if (reportData) {
          breachReports.push(reportData);
        }
      } catch (error) {
        console.error(`Error processing URL ${url}:`, error.message);
      }
    }
    
    return breachReports;
  } catch (error) {
    console.error('Error in getMaineData:', error);
    throw error;
  }
}

// Function to get Texas data
async function getTexasData(browser) {
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    
    await page.goto('https://oag.my.site.com/datasecuritybreachreport/apex/DataSecurityReportsPage', {
      waitUntil: 'networkidle2'
    });
    
    await page.waitForTimeout(5000);
    
    try {
      const lastButton = await page.$('#mycdrs_last');
      if (lastButton) {
        await lastButton.click();
        await page.waitForTimeout(3000);
      }
    } catch (error) {
      console.error('Error clicking last button:', error.message);
    }
    
    const tableData = await page.evaluate(() => {
      const tables = document.querySelectorAll('table');
      if (tables.length === 0) return [];
      
      const table = tables[0];
      const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent.trim());
      
      const rows = Array.from(table.querySelectorAll('tr')).slice(1);
      
      return rows.map(row => {
        const cells = Array.from(row.querySelectorAll('td'));
        const rowData = {};
        
        headers.forEach((header, index) => {
          if (cells[index]) {
            rowData[header] = cells[index].textContent.trim();
          } else {
            rowData[header] = null;
          }
        });
        
        rowData['URL'] = 'https://oag.my.site.com/datasecuritybreachreport/apex/DataSecurityReportsPage';
        
        return rowData;
      }).slice(0, 15); // Limit to 15 records for demonstration
    });
    
    return tableData;
  } catch (error) {
    console.error('Error in getTexasData:', error);
    throw error;
  }
}

// Add a simple health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`API endpoint: http://localhost:${PORT}/api/breach-data`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
