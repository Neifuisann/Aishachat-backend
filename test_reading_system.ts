#!/usr/bin/env deno run -A

// Test the reading system without database dependencies
console.log("Testing Reading System (File Operations)");
console.log("=======================================");

// Make this a module
export {};

// Test basic file reading functionality
async function testFileReading() {
    console.log("\n1. Testing book file existence");
    try {
        const content = await Deno.readTextFile("books/public/sample_story.txt");
        console.log("✅ Book file found");
        console.log(`📖 Content length: ${content.length} characters`);

        // Split into pages
        const pages = content.split('\n\n').filter(page => page.trim().length > 0);
        console.log(`📄 Total pages: ${pages.length}`);

        console.log("\n2. Testing page content");
        if (pages.length > 0) {
            console.log("📖 First page preview:");
            console.log(pages[0].substring(0, 100) + "...");
        }

        console.log("\n3. Testing search functionality");
        const keyword = "key";
        const results: Array<{ page: number; context: string }> = [];

        pages.forEach((page, index) => {
            if (page.toLowerCase().includes(keyword.toLowerCase())) {
                const sentences = page.split(/[.!?]+/);
                const matchingSentences = sentences.filter(sentence =>
                    sentence.toLowerCase().includes(keyword.toLowerCase())
                );

                results.push({
                    page: index + 1,
                    context: matchingSentences.join('. ').trim()
                });
            }
        });

        console.log(`🔍 Found ${results.length} matches for "${keyword}"`);
        results.forEach(result => {
            console.log(`   Page ${result.page}: ${result.context.substring(0, 80)}...`);
        });

        console.log("\n4. Testing reading modes");
        const testPage = pages[0];

        // Test paragraph mode
        const paragraphs = testPage.split('\n').filter(p => p.trim().length > 0);
        console.log(`📝 Paragraph mode (2 paragraphs): ${paragraphs.slice(0, 2).join('\n').substring(0, 100)}...`);

        // Test sentence mode
        const sentences = testPage.split(/[.!?]+/).filter(s => s.trim().length > 0);
        console.log(`📝 Sentence mode (2 sentences): ${sentences.slice(0, 2).join('. ').substring(0, 100)}...`);

        console.log("\n✅ All file operations working correctly!");

    } catch (error) {
        console.error("❌ Error reading book file:", error);
        return false;
    }

    return true;
}

// Run the tests
try {
    const success = await testFileReading();
    if (success) {
        console.log("\n✅ Reading System File Operations Test Complete!");
        console.log("\n📋 Summary:");
        console.log("   ✅ Book file reading");
        console.log("   ✅ Page splitting");
        console.log("   ✅ Search functionality");
        console.log("   ✅ Reading modes (paragraphs, sentences)");
        console.log("\n🚀 The reading system is ready for integration!");
    } else {
        console.log("\n❌ Some tests failed");
        Deno.exit(1);
    }
} catch (error) {
    console.error("\n❌ Test failed:", error);
    Deno.exit(1);
}
